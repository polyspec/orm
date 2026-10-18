// Shared cases of audit and restore: auditCase checks, on a connection where contracts/fixtures/audit.dbs is installed, the writes of a transaction that received an audit record
// (auditCase in packages/go/orm/audit_transaction_test.go), and restoreCase
// restores a soft-deleted row with restore on a connection where restore.dbs is installed (restoreCase in restore_test.go). It has the same order and
// results. The owner test (dbspec_runtime_db.mjs) and the coverage case (coverage_audit_triggers.mjs) both use it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CORE, Db, Model, OrmError, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
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

/** An audit source that gives the actor as the audit value. Used as the connection option auditSource. */
export function auditSource(actor) {
  return () => ({ actor });
}

/** Writes values to a new model of cls. */
function modelWith(cls, values) {
  const m = new cls();
  for (const [column, value] of Object.entries(values)) m[CORE].setValue(column, value);
  return m;
}

/**
 * Runs the Go auditCase on a db where audit.dbs is installed and the item and audit tables have no rows. The auditSource of the db is
 * auditSource('default').
 * - Before the callback, the transaction inserts one record that combines the value given by the connection option's audit source and the transaction's audit value
 *   into the references table of the audit setting (for the same column, the transaction value wins), and the insert of the audit table,
 *   update, and soft delete write that primary key to the audit column. The trigger keeps each version in the history table
 *   and previous is the audit key of the previous version.
 * - An audit transaction on a connection without an audit source, and a value that is not a column of the audit record table (a value of the transaction or the source,
 *   is CONFIG), and an error thrown by the source is an error of the transaction.
 * - A nested transaction writes the outer audit and does not receive its own audit (CONFIG).
 * - A write to an audit table without an audit is CONFIG. A raw write that points to a nonexistent audit record is rejected by the foreign key.
 * - If the callback fails, the audit record is also rolled back.
 */
export async function auditCase(db, driver, dsn) {
  const { item: Item, item_history: ItemHistory, audit: Audit } = modelsOf(auditText);
  const item = values => modelWith(Item, values).connect(db);
  assert.equal(await codeOf(item({ title: 'outside' }).create()), 'CONFIG', 'insert without an audit');
  for (const [name, options] of [['without an audit source', {}], ['with a source value that is no column', { auditSource: () => ({ reason: 'x' }) }]]) {
    const other = await Db.connectSchema(dsn, auditSchema(), options);
    try {
      assert.equal(await codeOf(other.transaction(async () => {}, { audit: { actor: 'x' } })), 'CONFIG', `an audit transaction of a connection ${name}`);
    } finally { await other.close(); }
  }
  const unavailable = new Error('no request');
  const failing = await Db.connectSchema(dsn, auditSchema(), { auditSource: () => { throw unavailable; } });
  let sourceError;
  try { await failing.transaction(async () => {}, { audit: {} }); } catch (error) { sourceError = error; } finally { await failing.close(); }
  assert.equal(sourceError, unavailable, 'an audit transaction whose source fails returns the source error');
  const adb = db;
  assert.equal(await codeOf(adb.transaction(async () => {}, { audit: { reason: 'x' } })), 'CONFIG', 'an audit value that is no column');
  let seq;
  await adb.transaction(async () => {
    seq = (await item({ title: 'first' }).create())[CORE].column('seq');
    assert.equal(await codeOf(adb.transaction(async () => {}, { audit: { actor: 'nested' } })), 'CONFIG', 'a nested transaction with an audit');
    // A nested transaction writes the outer audit.
    await db.transaction(async () => { await item({ seq, title: 'second' }).update(); }, { retry: 0 });
  }, { audit: { actor: 'create' }, retry: 0 });
  assert.equal(await codeOf(item({ seq, title: 'third' }).update()), 'CONFIG', 'update without an audit');
  // An audit transaction with no values records only the defaults.
  await adb.transaction(async () => { await item({ seq }).delete(); }, { audit: {}, retry: 0 });
  const failed = new Error('callback failed');
  let thrown;
  try { await adb.transaction(async () => { throw failed; }, { audit: { actor: 'rolled back' }, retry: 0 }); } catch (error) { thrown = error; }
  assert.equal(thrown, failed, 'a failed callback returns its error');

  let raw = null;
  try { await nativeQuery(driver, dsn, ["INSERT INTO item (title, audit_seq) VALUES ('raw', 999)"]); } catch (error) { raw = error; }
  assert.notEqual(raw, null, 'a raw insert that names no audit record succeeded; the foreign key rejects it');
  const audits = await new Audit().connect(db).orderBySeqAsc().gets();
  assert.deepEqual(audits.values().map(a => [a[CORE].column('seq'), a[CORE].column('actor')]), [[1, 'create'], [2, 'default']], 'audit records');
  const history = await new ItemHistory().connect(db).addAllColumns().orderByHistoryIdAsc().gets();
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
 * Runs the Go restoreCase on a db where restore.dbs is installed and auditSource is auditSource('default'). membership is an audit table with unique key (team_id, member_id) and
 * exclude (note), and label is a table without audit that has unique key (name).
 * - The unique key value of a soft-deleted row remains, so an insert with the same key is DUPLICATE_KEY.
 * - A default read does not read deleted rows.
 * - restore sends only the set values, finds the deleted row by the key chosen by the planner, runs an update that writes the soft delete column as NULL, and returns the restored row.
 *   If the table is audited, it writes the transaction's audit record key; without audit it is CONFIG.
 * - Restoring a row that was not deleted writes nothing and returns that row; a row that does not exist fails with NO_ROWS; a default read of a soft-deleted row returns null.
 * - A set value outside the key is a new value written together into the restored row, and is not written to rows that were not deleted.
 * - A restore with no key value is IR_INVALID without a statement.
 * The key of an audit record can skip numbers written by a failed transaction differently in each database, so records are found by actor.
 */
export async function restoreCase(db) {
  const { membership: Membership, membership_history: MembershipHistory, label: Label, audit: Audit } = modelsOf(restoreText);
  const make = (cls, values) => modelWith(cls, values).connect(db);
  const auditSeq = async actor => {
    const rows = await new Audit().connect(db).actor(actor).gets();
    assert.equal(rows.length, 1, `audit records of ${actor}`);
    return rows.values()[0][CORE].column('seq');
  };
  const adb = db;
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
  assert.equal(await new Label().connect(db).name('red').get(), null, 'default read of a soft-deleted row');
  assert.equal(await codeOf(make(Membership, { team_id: 1, member_id: 2 }).restore()), 'CONFIG', 'restore of an audited row without an audit');

  // A set value outside the key is a new value written together into the restored row.
  const restored = await adb.transaction(() => make(Membership, { team_id: 1, member_id: 2, note: 'n2' }).restore(), { audit: { actor: 'restore' }, retry: 0 });
  assert.deepEqual(columns(restored, membershipColumns), { seq, team_id: 1, member_id: 2, note: 'n2', audit_seq: await auditSeq('restore'), deleted_at: null }, 'restored membership');
  const again = await adb.transaction(() => make(Membership, { seq, note: 'n3' }).restore(), { audit: { actor: 'again' }, retry: 0 });
  assert.deepEqual(columns(again, membershipColumns), columns(restored, membershipColumns), 'restore of a row that is not deleted returns the unchanged row');

  const label = await make(Label, { name: 'red', color: 'y' }).restore();
  assert.deepEqual(columns(label, ['id', 'name', 'color', 'deleted_at']), { id, name: 'red', color: 'y', deleted_at: null }, 'restored label');
  assert.equal(await codeOf(make(Label, { name: 'blue' }).restore()), 'NO_ROWS', 'restore of an absent row');
  assert.equal(await codeOf(make(Label, { color: 'x' }).restore()), 'IR_INVALID', 'restore without the values of a key');
  assert.equal(await codeOf(make(Label, {}).restore()), 'IR_INVALID', 'restore without key values');

  const [create, remove, restore] = [await auditSeq('create'), await auditSeq('delete'), await auditSeq('restore')];
  const history = await new MembershipHistory().connect(db).addAllColumns().orderByHistoryIdAsc().gets();
  assert.deepEqual(history.values().map(h => [
    h[CORE].column('change'), h[CORE].column('previous_audit_seq'), h[CORE].column('seq'), h[CORE].column('team_id'),
    h[CORE].column('member_id'), h[CORE].column('audit_seq'), h[CORE].column('deleted_at') === null ? 'live' : 'deleted',
  ]), [
    ['insert', null, seq, 1, 2, create, 'live'],
    ['update', create, seq, 1, 2, remove, 'deleted'],
    ['update', remove, seq, 1, 2, restore, 'live'],
  ], 'membership_history in history_id order');
  assert.equal(await new Audit().connect(db).actor('duplicate').getCount(), 0, 'audit records of the failed transaction');
  assert.equal(await new Label().connect(db).getCount(), 1, 'live labels');
}
