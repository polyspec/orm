// audit_triggers coverage: installs the audit fixture with schema install and, with packages/go/orm/coverage_audit_triggers_test.go,
// writes in the same order, then checks the history table left by the trigger. At the end, even on failure, it removes the installed tables and the PostgreSQL trigger
// function, returning the database to its initial state.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CORE, Db, Model, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { errorCode, nativeQuery, repositoryRoot, runCases, tableExists, withCleanup } from './coverage_case.mjs';
import { auditCase, auditSchema, auditSource, auditText, restoreCase, restoreSchema, restoreTables } from './restore_case.mjs';

const auditColumnsText = await readFile(join(repositoryRoot, 'contracts/fixtures/audit_columns.dbs'), 'utf8');

/** The tables that contracts/fixtures/audit.dbs creates. */
const auditTables = ['audit', 'item', 'item_history'];
/** The tables that contracts/fixtures/audit_columns.dbs creates. */
const auditColumnsTables = ['audit', 'card', 'card_history', 'tag', 'tag_history'];

/** A document text's generated schema value: its manifest text and manifestHash. */
function schemaOf(text) {
  const { manifest } = dbspecManifest([parseDbspec(text, {}).document]);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
}

/** Registers the model of an audit document and returns a model class per entity. */
function auditModels(text = auditText) {
  const parsed = parseDbspec(text, {});
  assert.deepEqual(parsed.diagnostics, [], 'the audit fixture parses');
  const { manifest, diagnostics } = dbspecManifest([parsed.document]);
  assert.deepEqual(diagnostics, [], 'the audit fixture has a manifest');
  const model = registerModel(manifest.manifestText, manifest.manifestHash);
  const out = {};
  for (const entity of model.entities.values()) {
    const cls = class extends Model {};
    cls.entity = { model, entity, create: core => new cls(core) };
    out[entity.name] = cls;
  }
  return out;
}

/**
 * Drops the tables in the chosen database (the audit record table after the tables that refer to it), and on PostgreSQL the audited
 * table's trigger function too.
 */
async function dropTables(driver, dsn, tables, audited) {
  const quote = driver === 'mysql' ? name => `\`${name}\`` : name => `"${name}"`;
  const statements = [...tables.filter(t => t !== 'audit'), 'audit'].map(t => `DROP TABLE IF EXISTS ${quote(t)}`);
  if (driver === 'postgres') {
    for (const t of audited) {
      for (const e of ['audit_insert', 'audit_update', 'audit_delete']) statements.push(`DROP FUNCTION IF EXISTS "${t}$${e}"()`);
    }
  }
  await nativeQuery(driver, dsn, statements);
}

/** Reads the column names and rows of a query as strings. NULL is 'NULL'. */
async function textRows(driver, dsn, sql) {
  const [rows] = await nativeQuery(driver, dsn, [sql]);
  return { columns: Object.keys(rows[0] ?? {}), rows: rows.map(r => Object.values(r).map(v => (v === null ? 'NULL' : String(v)))) };
}

/**
 * Installs the schema in the chosen database, runs body(db, driver, dsn), then, even on failure, drops the tables and the audited table's
 * PostgreSQL trigger function. The tables must not exist before the case and must not remain after it.
 */
async function withInstalled({ driver, dsn }, schema, tables, audited, body) {
  for (const table of tables) {
    assert.equal(await tableExists(driver, dsn, table), false, `table ${table} does not exist before the case`);
  }
  const db = await Db.connect(dsn, { auditSource: auditSource('default') });
  try {
    assert.equal(db.driver, driver);
    await withCleanup(async () => {
      await db.utils().schema().install(schema);
      await body(db, driver, dsn);
    }, () => dropTables(driver, dsn, tables, audited));
  } finally { await db.close(); }
  for (const table of tables) {
    assert.equal(await tableExists(driver, dsn, table), false, `table ${table} is dropped after the case`);
  }
}

await runCases('coverage_audit_triggers.mjs', {
  // contracts/fixtures/audit.dbs: checks the writes of a transaction that received an audit record (tests/restore_case.mjs).
  // Requirements: CFG-8.
  async audit_history(item) {
    await withInstalled(item, auditSchema(), auditTables, ['item'], (db, driver, dsn) => auditCase(db, driver, dsn));
  },
  // Every transaction entry point receives the audit: the transaction of the connection and the transaction of that connection's withSignal handle
  // writes the key of the inserted audit record in the audited write, and a nested transaction receives no audit. The withSignal handle
  // also uses the audit source of the connection.
  async audit_transaction_entry_points(item) {
    const { item: Item, item_history: ItemHistory, audit: Audit } = auditModels();
    await withInstalled(item, auditSchema(), auditTables, ['item'], async db => {
      const adb = db;
      const seq = await adb.transaction(async () => {
        const row = new Item();
        row[CORE].setValue('title', 'first');
        return (await row.create())[CORE].column('seq');
      }, { audit: { actor: 'transaction' }, retry: 0 });
      const handle = adb.withSignal(new AbortController().signal);
      await handle.transaction(async () => {
        const row = await new Item().seq(seq).get();
        row[CORE].setValue('title', 'second');
        await row.update();
      }, { audit: { actor: 'signal' }, retry: 0 });
      const nested = adb.transaction(async () => { await adb.transaction(async () => {}, { audit: { actor: 'nested' } }); }, { audit: {}, retry: 0 });
      assert.equal(await errorCode(nested), 'CONFIG', 'a nested transaction with an audit');
      const history = await new ItemHistory().connect(db).addAllColumns().orderByHistoryIdAsc().gets();
      assert.deepEqual(history.values().map(h => [
        h[CORE].column('change'), h[CORE].column('previous_audit_seq'), h[CORE].column('seq'), h[CORE].column('title'),
        h[CORE].column('audit_seq'), h[CORE].column('deleted_at') !== null,
      ]), [
        ['insert', null, seq, 'first', 1, false],
        ['update', 1, seq, 'second', 2, false],
      ], 'item_history in history_id order');
      const audits = await new Audit().connect(db).orderBySeqAsc().gets();
      assert.deepEqual(audits.values().map(a => [a[CORE].column('seq'), a[CORE].column('actor')]), [[1, 'transaction'], [2, 'signal']], 'audit records');
    });
  },
  // contracts/fixtures/audit_columns.dbs: card excludes secret with exclude (secret), and tag includes label with include (label),
  // so only label and the audit column are recorded. The audit trigger records the insert, update, and soft delete written by the client using only the chosen columns,
  // and the history table holds only the recorded columns.
  async audit_selected_columns(item) {
    const { card: Card, tag: Tag } = auditModels(auditColumnsText);
    await withInstalled(item, schemaOf(auditColumnsText), auditColumnsTables, ['card', 'tag'], async (db, driver, dsn) => {
      const adb = db;
      let seq;
      let id;
      await adb.transaction(async () => {
        const card = new Card();
        card[CORE].setValue('title', 'first');
        card[CORE].setValue('secret', 's1');
        seq = (await card.create())[CORE].column('seq');
        const tag = new Tag();
        tag[CORE].setValue('label', 'x');
        tag[CORE].setValue('color', 'red');
        id = (await tag.create())[CORE].column('id');
        const row = await new Card().seq(seq).get();
        row[CORE].setValue('title', 'second');
        row[CORE].setValue('secret', 's2');
        await row.update();
      }, { audit: { actor: 'first' }, retry: 0 });
      await adb.transaction(async () => {
        await (await new Card().seq(seq).get()).delete();
        const tag = await new Tag().id(id).get();
        tag[CORE].setValue('color', 'blue');
        await tag.update();
      }, { audit: { actor: 'second' }, retry: 0 });
      const change = driver === 'mysql' ? '`change`' : '"change"';
      const cards = await textRows(driver, dsn, 'SELECT * FROM card_history ORDER BY history_id');
      assert.deepEqual(cards.columns, ['history_id', 'change', 'previous_audit_seq', 'seq', 'title', 'audit_seq', 'deleted_at'], 'card_history columns');
      const cardRows = await textRows(driver, dsn, `SELECT ${change}, previous_audit_seq, seq, title, audit_seq, CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END AS state FROM card_history ORDER BY history_id`);
      assert.deepEqual(cardRows.rows, [
        ['insert', 'NULL', String(seq), 'first', '1', 'live'],
        ['update', '1', String(seq), 'second', '1', 'live'],
        ['update', '1', String(seq), 'second', '2', 'deleted'],
      ], 'card_history in history_id order');
      const tags = await textRows(driver, dsn, 'SELECT * FROM tag_history ORDER BY history_id');
      assert.deepEqual(tags.columns, ['history_id', 'change', 'previous_audit_seq', 'label', 'audit_seq'], 'tag_history columns');
      const tagRows = await textRows(driver, dsn, `SELECT ${change}, previous_audit_seq, label, audit_seq FROM tag_history ORDER BY history_id`);
      assert.deepEqual(tagRows.rows, [['insert', 'NULL', 'x', '1'], ['update', '1', 'x', '2']], 'tag_history in history_id order');
    });
  },
  // contracts/fixtures/restore.dbs: a soft delete of one row in an audit table that has a unique key and an exclude list, and in a table without audit,
  // restored with restore (tests/restore_case.mjs).
  async soft_delete_restore(item) {
    await withInstalled(item, restoreSchema(), restoreTables, ['membership'], db => restoreCase(db));
  },
}, 300_000);
