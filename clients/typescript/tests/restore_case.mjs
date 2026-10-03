// audit 와 restore 의 공유 case: auditCase 는 contracts/fixtures/audit.dbs 를 설치한 연결에서 audit 기록을 받은
// transaction 의 write 를 확인하고(clients/go/orm/audit_transaction_test.go 의 auditCase), restoreCase 는
// restore.dbs 를 설치한 연결에서 soft delete 한 행을 restore 로 되돌린다(restore_test.go 의 restoreCase). 같은 순서와
// 결과다. owner test(dbspec_runtime_db.mjs)와 coverage case(coverage_audit_triggers.mjs)가 함께 쓴다.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CORE, Model, OrmError, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { nativeQuery } from './coverage_case.mjs';

export const restoreText = await readFile(new URL('../../../contracts/fixtures/restore.dbs', import.meta.url), 'utf8');
export const auditText = await readFile(new URL('../../../contracts/fixtures/audit.dbs', import.meta.url), 'utf8');

/** The tables that contracts/fixtures/restore.dbs creates. */
export const restoreTables = ['audit', 'label', 'membership', 'membership_history'];

/** The generated schema value of a document text: its manifest text and manifestHash. */
function schemaOf(text) {
  const { manifest } = dbspecManifest([parseDbspec(text, {}).document]);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
}

/** The generated schema value of the restore fixture. */
export function restoreSchema() { return schemaOf(restoreText); }

/** The generated schema value of the audit fixture. */
export function auditSchema() { return schemaOf(auditText); }

/** Registers the model of a document text and returns a model class per entity. */
function modelsOf(text) {
  const parsed = parseDbspec(text, {});
  assert.deepEqual(parsed.diagnostics, [], 'the fixture parses');
  const { manifest } = dbspecManifest([parsed.document]);
  const model = registerModel(manifest.manifestText, manifest.manifestHash);
  const out = {};
  for (const entity of model.entities.values()) {
    const cls = class extends Model {};
    cls.entity = { model, entity, create: core => new cls(core) };
    out[entity.name] = cls;
  }
  return out;
}

async function codeOf(promise) {
  try { await promise; return null; } catch (error) { return error instanceof OrmError ? error.code : String(error); }
}

/** cls 의 새 model 에 values 를 쓴다. */
function modelWith(cls, values) {
  const m = new cls();
  for (const [column, value] of Object.entries(values)) m[CORE].setValue(column, value);
  return m;
}

/**
 * audit.dbs 가 설치되고 item 과 audit 에 행이 없는 db 에서 Go auditCase 를 실행한다.
 * - handle 의 audit 기본값과 transaction 의 audit 값을 합친 기록 하나를 transaction 이 callback 전에 삽입하고(같은
 *   column 이면 transaction 값이 이긴다), audit table 의 insert, update, soft delete 는 그 primary key 를 audit column
 *   에 쓴다. trigger 가 각 version 을 history table 에 남기고 previous 는 이전 version 의 audit key 다.
 * - 기본값이 없는 연결의 audit transaction 과 audit 기록 table 의 column 이 아닌 값은 CONFIG 다.
 * - 중첩 transaction 은 바깥 audit 을 쓰며 자기 audit 을 받지 않는다(CONFIG).
 * - audit 없는 audit table write 는 CONFIG 다. 없는 audit 기록을 가리키는 raw write 는 foreign key 가 거부한다.
 * - callback 이 실패하면 audit 기록도 rollback 된다.
 */
export async function auditCase(db, driver, dsn) {
  const { item: Item, item_history: ItemHistory, audit: Audit } = modelsOf(auditText);
  const item = values => modelWith(Item, values).connect(db);
  assert.equal(await codeOf(item({ title: 'outside' }).create()), 'CONFIG', 'insert without an audit');
  assert.equal(await codeOf(db.transaction(async () => {}, { audit: { actor: 'x' } })), 'CONFIG', 'an audit transaction of a connection without audit defaults');
  const adb = db.audit(modelWith(Audit, { actor: 'default' }));
  assert.equal(await codeOf(adb.transaction(async () => {}, { audit: { reason: 'x' } })), 'CONFIG', 'an audit value that is no column');
  let seq;
  await adb.transaction(async () => {
    seq = (await item({ title: 'first' }).create())[CORE].column('seq');
    assert.equal(await codeOf(adb.transaction(async () => {}, { audit: { actor: 'nested' } })), 'CONFIG', 'a nested transaction with an audit');
    // 중첩 transaction 은 바깥 audit 을 쓴다.
    await db.transaction(async () => { await item({ seq, title: 'second' }).update(); }, { retry: 0 });
  }, { audit: { actor: 'create' }, retry: 0 });
  assert.equal(await codeOf(item({ seq, title: 'third' }).update()), 'CONFIG', 'update without an audit');
  // 값이 없는 audit transaction 은 기본값만으로 기록한다.
  await adb.transaction(async () => { await item({ seq }).delete(); }, { audit: {}, retry: 0 });
  const failed = new Error('callback failed');
  let thrown;
  try { await adb.transaction(async () => { throw failed; }, { audit: { actor: 'rolled back' }, retry: 0 }); } catch (error) { thrown = error; }
  assert.equal(thrown, failed, 'a failed callback returns its error');

  let raw = null;
  try { await nativeQuery(driver, dsn, ["INSERT INTO item (title, audit_seq) VALUES ('raw', 999)"]); } catch (error) { raw = error; }
  assert.notEqual(raw, null, 'a raw insert that names no audit record succeeded; the foreign key rejects it');
  const audits = await new Audit().connect(db).orderByRaw('{seq} ASC').gets();
  assert.deepEqual(audits.values().map(a => [a[CORE].column('seq'), a[CORE].column('actor')]), [[1, 'create'], [2, 'default']], 'audit records');
  const history = await new ItemHistory().connect(db).addAllColumns().orderByRaw('{history_id} ASC').gets();
  assert.deepEqual(history.values().map(h => [
    h[CORE].column('change'), h[CORE].column('previous_audit_seq'), h[CORE].column('seq'), h[CORE].column('title'),
    h[CORE].column('audit_seq'), h[CORE].column('deleted_at') !== null,
  ]), [
    ['insert', null, seq, 'first', 1, false],
    ['update', 1, seq, 'second', 1, false],
    ['update', 1, seq, 'second', 2, true],
  ], 'item_history in history_id order');
}

/**
 * restore.dbs 가 설치된 db 에서 Go restoreCase 를 실행한다. membership 은 unique key (team_id, member_id)와
 * exclude (note)를 가진 audit table 이고 label 은 unique key (name)를 가진 audit 없는 table 이다.
 * - soft delete 한 행의 unique key 값은 남으므로 같은 key 의 insert 는 DUPLICATE_KEY 다.
 * - 기본 read 는 지운 행을 읽지 않는다.
 * - restore 는 지운 행을 key 로 찾아 soft delete column 을 NULL 로 쓰는 update 를 하고 되돌린 행을 돌려준다.
 *   audit table 이면 transaction 의 audit 기록 key 를 쓰고, audit 이 없으면 CONFIG 다.
 * - 지워지지 않은 행의 restore 는 아무것도 쓰지 않고 그 행을, 없는 행은 NO_ROWS 를 돌려준다.
 * - key 밖의 set 값은 되돌리는 행에 함께 쓰는 새 값이며, 지워지지 않은 행에는 쓰지 않는다.
 * - key 의 값이 없는 restore 는 CONFIG 다.
 * audit 기록의 key 는 실패한 transaction 이 쓴 번호를 database 마다 다르게 건너뛸 수 있으므로 actor 로 찾는다.
 */
export async function restoreCase(db) {
  const { membership: Membership, membership_history: MembershipHistory, label: Label, audit: Audit } = modelsOf(restoreText);
  const make = (cls, values) => modelWith(cls, values).connect(db);
  const auditSeq = async actor => {
    const rows = await new Audit().connect(db).raw('{actor} = ?', actor).gets();
    assert.equal(rows.length, 1, `audit records of ${actor}`);
    return rows.values()[0][CORE].column('seq');
  };
  const adb = db.audit(modelWith(Audit, { actor: 'default' }));
  const columns = (m, names) => Object.fromEntries(names.map(n => [n, m[CORE].column(n)]));
  const membershipColumns = ['seq', 'team_id', 'member_id', 'note', 'audit_seq', 'deleted_at'];
  let seq;
  let id;
  await adb.transaction(async () => {
    seq = (await make(Membership, { team_id: 1, member_id: 2, note: 'n1' }).create())[CORE].column('seq');
    id = (await make(Label, { name: 'red', color: 'x' }).create())[CORE].column('id');
  }, { audit: { actor: 'create' }, retry: 0 });
  await adb.transaction(async () => {
    await make(Membership, { seq }).delete();
    await make(Label, { id }).delete();
  }, { audit: { actor: 'delete' }, retry: 0 });

  assert.equal(await codeOf(adb.transaction(async () => { await make(Membership, { team_id: 1, member_id: 2 }).create(); }, { audit: { actor: 'duplicate' }, retry: 0 })),
    'DUPLICATE_KEY', 'insert of the key of a soft-deleted row');
  assert.equal(await codeOf(new Label().connect(db).raw('{name} = ?', 'red').get()), 'NO_ROWS', 'default read of a soft-deleted row');
  assert.equal(await codeOf(make(Membership, { team_id: 1, member_id: 2 }).restore()), 'CONFIG', 'restore of an audited row without an audit');

  // key 밖의 set 값은 되돌리는 행에 함께 쓰는 새 값이다.
  const restored = await adb.transaction(() => make(Membership, { team_id: 1, member_id: 2, note: 'n2' }).restore(), { audit: { actor: 'restore' }, retry: 0 });
  assert.deepEqual(columns(restored, membershipColumns), { seq, team_id: 1, member_id: 2, note: 'n2', audit_seq: await auditSeq('restore'), deleted_at: null }, 'restored membership');
  const again = await adb.transaction(() => make(Membership, { seq, note: 'n3' }).restore(), { audit: { actor: 'again' }, retry: 0 });
  assert.deepEqual(columns(again, membershipColumns), columns(restored, membershipColumns), 'restore of a row that is not deleted returns the unchanged row');

  const label = await make(Label, { name: 'red', color: 'y' }).restore();
  assert.deepEqual(columns(label, ['id', 'name', 'color', 'deleted_at']), { id, name: 'red', color: 'y', deleted_at: null }, 'restored label');
  assert.equal(await codeOf(make(Label, { name: 'blue' }).restore()), 'NO_ROWS', 'restore of an absent row');
  assert.equal(await codeOf(make(Label, { color: 'x' }).restore()), 'CONFIG', 'restore without the values of a key');
  assert.equal(await codeOf(make(Label, {}).restore()), 'CONFIG', 'restore without key values');

  const [create, remove, restore] = [await auditSeq('create'), await auditSeq('delete'), await auditSeq('restore')];
  const history = await new MembershipHistory().connect(db).addAllColumns().orderByRaw('{history_id} ASC').gets();
  assert.deepEqual(history.values().map(h => [
    h[CORE].column('change'), h[CORE].column('previous_audit_seq'), h[CORE].column('seq'), h[CORE].column('team_id'),
    h[CORE].column('member_id'), h[CORE].column('audit_seq'), h[CORE].column('deleted_at') === null ? 'live' : 'deleted',
  ]), [
    ['insert', null, seq, 1, 2, create, 'live'],
    ['update', create, seq, 1, 2, remove, 'deleted'],
    ['update', remove, seq, 1, 2, restore, 'live'],
  ], 'membership_history in history_id order');
  assert.equal(await new Audit().connect(db).raw('{actor} = ?', 'duplicate').getCount(), 0, 'audit records of the failed transaction');
  assert.equal(await new Label().connect(db).getCount(), 1, 'live labels');
}
