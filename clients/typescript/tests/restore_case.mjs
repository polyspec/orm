// audit 와 restore 의 공유 case: restoreCase 는 contracts/fixtures/restore.dbs 를 설치한 연결에서 soft delete 한 행을
// restore 로 되돌리고(clients/go/orm/restore_test.go 의 restoreCase), setOperationCase 는 audit.dbs 에서 시작한
// transaction 안에 operation id 를 정한다(audit_operation_test.go 의 setOperationCase). 같은 순서와 결과다. owner
// test(dbspec_runtime_db.mjs)와 coverage case(coverage_audit_triggers.mjs)가 함께 쓴다.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CORE, Model, OrmError, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';

export const restoreText = await readFile(new URL('../../../contracts/fixtures/restore.dbs', import.meta.url), 'utf8');

/** The tables that contracts/fixtures/restore.dbs creates. */
export const restoreTables = ['label', 'membership', 'membership_history'];

/** The generated schema value of the restore fixture. */
export function restoreSchema() {
  const { manifest } = dbspecManifest([parseDbspec(restoreText, {}).document]);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
}

/** Registers the model of the restore fixture and returns a model class per entity. */
function restoreModels() {
  const parsed = parseDbspec(restoreText, {});
  assert.deepEqual(parsed.diagnostics, [], 'restore.dbs parses');
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

/**
 * restore.dbs 가 설치된 db 에서 Go restoreCase 를 실행한다. membership 은 unique key (team_id, member_id)와
 * exclude (note)를 가진 audit table 이고 label 은 unique key (name)를 가진 audit 없는 table 이다.
 * - soft delete 한 행의 unique key 값은 남으므로 같은 key 의 insert 는 DUPLICATE_KEY 다.
 * - 기본 read 는 지운 행을 읽지 않는다.
 * - restore 는 지운 행을 key 로 찾아 soft delete column 을 NULL 로 쓰는 update 를 하고 되돌린 행을 돌려준다.
 *   audit table 이면 transaction 의 operation id 를 쓰고, 없으면 CONFIG 다.
 * - 지워지지 않은 행의 restore 는 아무것도 쓰지 않고 그 행을, 없는 행은 NO_ROWS 를 돌려준다.
 * - key 밖의 set 값은 되돌리는 행에 함께 쓰는 새 값이며, 지워지지 않은 행에는 쓰지 않는다.
 * - key 의 값이 없는 restore 는 CONFIG 다.
 */
export async function restoreCase(db) {
  const { membership: Membership, membership_history: MembershipHistory, label: Label } = restoreModels();
  const make = (cls, values) => {
    const m = new cls().connect(db);
    for (const [column, value] of Object.entries(values)) m[CORE].setValue(column, value);
    return m;
  };
  const columns = (m, names) => Object.fromEntries(names.map(n => [n, m[CORE].column(n)]));
  const membershipColumns = ['seq', 'team_id', 'member_id', 'note', 'operation_id', 'deleted_at'];
  let seq;
  let id;
  await db.transaction(async () => {
    seq = (await make(Membership, { team_id: 1, member_id: 2, note: 'n1' }).create())[CORE].column('seq');
    id = (await make(Label, { name: 'red', color: 'x' }).create())[CORE].column('id');
  }, { operation: 1, retry: 0 });
  await db.transaction(async () => {
    await make(Membership, { seq }).delete();
    await make(Label, { id }).delete();
  }, { operation: 2, retry: 0 });

  assert.equal(await codeOf(db.transaction(async () => { await make(Membership, { team_id: 1, member_id: 2 }).create(); }, { operation: 3, retry: 0 })),
    'DUPLICATE_KEY', 'insert of the key of a soft-deleted row');
  assert.equal(await codeOf(new Label().connect(db).raw('{name} = ?', 'red').get()), 'NO_ROWS', 'default read of a soft-deleted row');
  assert.equal(await codeOf(make(Membership, { team_id: 1, member_id: 2 }).restore()), 'CONFIG', 'restore of an audited row without an operation id');

  // key 밖의 set 값은 되돌리는 행에 함께 쓰는 새 값이다.
  const restored = await db.transaction(() => make(Membership, { team_id: 1, member_id: 2, note: 'n2' }).restore(), { operation: 4, retry: 0 });
  assert.deepEqual(columns(restored, membershipColumns), { seq, team_id: 1, member_id: 2, note: 'n2', operation_id: 4, deleted_at: null }, 'restored membership');
  const again = await db.transaction(() => make(Membership, { seq, note: 'n3' }).restore(), { operation: 5, retry: 0 });
  assert.deepEqual(columns(again, membershipColumns), columns(restored, membershipColumns), 'restore of a row that is not deleted returns the unchanged row');

  const label = await make(Label, { name: 'red', color: 'y' }).restore();
  assert.deepEqual(columns(label, ['id', 'name', 'color', 'deleted_at']), { id, name: 'red', color: 'y', deleted_at: null }, 'restored label');
  assert.equal(await codeOf(make(Label, { name: 'blue' }).restore()), 'NO_ROWS', 'restore of an absent row');
  assert.equal(await codeOf(make(Label, { color: 'x' }).restore()), 'CONFIG', 'restore without the values of a key');
  assert.equal(await codeOf(make(Label, {}).restore()), 'CONFIG', 'restore without key values');

  const history = await new MembershipHistory().connect(db).addAllColumns().orderByRaw('{history_id} ASC').gets();
  assert.deepEqual(history.values().map(h => [
    h[CORE].column('change'), h[CORE].column('previous_operation_id'), h[CORE].column('seq'), h[CORE].column('team_id'),
    h[CORE].column('member_id'), h[CORE].column('operation_id'), h[CORE].column('deleted_at') === null ? 'live' : 'deleted',
  ]), [
    ['insert', null, seq, 1, 2, 1, 'live'],
    ['update', 1, seq, 1, 2, 2, 'deleted'],
    ['update', 2, seq, 1, 2, 4, 'live'],
  ], 'membership_history in history_id order');
  assert.equal(await new Label().connect(db).getCount(), 1, 'live labels');
}

export const auditText = await readFile(new URL('../../../contracts/fixtures/audit.dbs', import.meta.url), 'utf8');

/** The generated schema value of the audit fixture. */
export function auditSchema() {
  const { manifest } = dbspecManifest([parseDbspec(auditText, {}).document]);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
}

/**
 * contracts/fixtures/audit.dbs 가 설치된 db 에서 Go setOperationCase 를 실행한다: 시작한 transaction 안에서
 * utils().setOperation(id)로 operation id 를 정한다(clients/go/orm/audit_operation_test.go).
 * - transaction 밖에서는 CONFIG 다. id 를 정하기 전의 audit 대상 write 와 safe integer 도 문자열도 아닌 id 는 CONFIG 다.
 * - 같은 id 는 아무것도 바꾸지 않고, 다른 id 는 중첩 transaction 에서도, transaction option 의 id 뒤에서도 CONFIG 다.
 * - rollback 한 savepoint 는 그 안에서 정한 id 를 되돌리고, 그 뒤의 audit 대상 write 는 다시 CONFIG 다.
 */
export async function setOperationCase(db) {
  const parsed = parseDbspec(auditText, {});
  const { manifest } = dbspecManifest([parsed.document]);
  const model = registerModel(manifest.manifestText, manifest.manifestHash);
  const classes = {};
  for (const entity of model.entities.values()) {
    const cls = class extends Model {};
    cls.entity = { model, entity, create: core => new cls(core) };
    classes[entity.name] = cls;
  }
  const { item: Item, item_history: ItemHistory } = classes;
  const item = values => {
    const m = new Item();
    for (const [column, value] of Object.entries(values)) m[CORE].setValue(column, value);
    return m;
  };
  const codeSync = fn => { try { fn(); return null; } catch (error) { return error instanceof OrmError ? error.code : String(error); } };
  assert.equal(codeSync(() => db.utils().setOperation(1)), 'CONFIG', 'setOperation outside a transaction');

  let seq;
  await db.transaction(async () => {
    assert.equal(await codeOf(item({ title: 'before' }).create()), 'CONFIG', 'an audited insert before setOperation');
    assert.equal(codeSync(() => db.utils().setOperation(1.5)), 'CONFIG', 'setOperation with a number that is not a safe integer');
    db.utils().setOperation(7);
    seq = (await item({ title: 'first' }).create())[CORE].column('seq');
    db.utils().setOperation(7);
    assert.equal(codeSync(() => db.utils().setOperation(8)), 'CONFIG', 'another operation id');
    await db.transaction(async () => {
      assert.equal(codeSync(() => db.utils().setOperation(9)), 'CONFIG', 'another operation id in a nested transaction');
      await item({ seq, title: 'second' }).update();
    }, { retry: 0 });
  }, { retry: 0 });

  const rolledBack = new Error('savepoint rolled back');
  await db.transaction(async () => {
    let nested;
    try {
      await db.transaction(async () => { db.utils().setOperation(10); throw rolledBack; }, { retry: 0 });
    } catch (error) { nested = error; }
    assert.equal(nested, rolledBack, 'the nested transaction returns its error');
    assert.equal(await codeOf(item({ seq, title: 'third' }).update()), 'CONFIG', 'an audited update after the savepoint that set the id rolled back');
    db.utils().setOperation(11);
    await item({ seq, title: 'third' }).update();
  }, { retry: 0 });

  await db.transaction(async () => {
    db.utils().setOperation(12);
    assert.equal(codeSync(() => db.utils().setOperation(13)), 'CONFIG', "another id than the option's");
    await item({ seq }).delete();
  }, { operation: 12, retry: 0 });

  // 이 case 가 쓴 행의 이력만 읽는다. owner test 에서는 앞 case 의 이력이 같은 table 에 있다.
  const history = await new ItemHistory().connect(db).addAllColumns().raw('{seq} = ?', seq).orderByRaw('{history_id} ASC').gets();
  assert.deepEqual(history.values().map(h => [
    h[CORE].column('change'), h[CORE].column('previous_operation_id'), h[CORE].column('seq'), h[CORE].column('title'),
    h[CORE].column('operation_id'), h[CORE].column('deleted_at') !== null,
  ]), [
    ['insert', null, seq, 'first', 7, false],
    ['update', 7, seq, 'second', 7, false],
    ['update', 7, seq, 'third', 11, false],
    ['update', 11, seq, 'third', 12, true],
  ], 'item_history in history_id order');
}
