// audit_triggers coverage: audit fixture 를 schema install 로 설치하고 clients/go/orm/coverage_audit_triggers_test.go 와
// 같은 순서로 쓴 뒤 trigger 가 남긴 history table 을 확인한다. 끝에, 실패해도 설치한 table 과 PostgreSQL trigger
// function 을 지워 database 를 처음 상태로 돌린다.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CORE, Db, Model, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { errorCode, featureDatabase, nativeQuery, repositoryRoot, runCases, tableExists, withCleanup } from './coverage_case.mjs';
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
 * 고른 database 에서 tables 를 지우고(audit 기록 table 은 그것을 가리키는 table 뒤에), PostgreSQL 에서는 audited
 * table 의 trigger function 도 지운다.
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

/** query의 column 이름과 row를 문자열로 읽는다. NULL은 'NULL'이다. */
async function textRows(driver, dsn, sql) {
  const [rows] = await nativeQuery(driver, dsn, [sql]);
  return { columns: Object.keys(rows[0] ?? {}), rows: rows.map(r => Object.values(r).map(v => (v === null ? 'NULL' : String(v)))) };
}

/**
 * 고른 database 에 schema 를 설치하고 body(db, driver, dsn)를 실행한 뒤, 실패해도 tables 와 audited table 의
 * PostgreSQL trigger function 을 지운다. tables 는 case 전에 없어야 하고 뒤에도 남지 않는다.
 */
async function withInstalled(schema, tables, audited, body) {
  const { driver, dsn } = featureDatabase();
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
  // contracts/fixtures/audit.dbs: audit 기록을 받은 transaction 의 write 를 확인한다(tests/restore_case.mjs).
  async audit_history() {
    await withInstalled(auditSchema(), auditTables, ['item'], (db, driver, dsn) => auditCase(db, driver, dsn));
  },
  // 모든 transaction 진입점이 audit 을 받는다: 연결의 transaction 과 그 연결의 withSignal handle 의 transaction 이
  // 삽입한 audit 기록의 key 를 audit 대상 write 가 쓰고, 중첩 transaction 은 audit 을 받지 않는다. withSignal handle 은
  // 연결의 audit source 를 함께 쓴다.
  async audit_transaction_entry_points() {
    const { item: Item, item_history: ItemHistory, audit: Audit } = auditModels();
    await withInstalled(auditSchema(), auditTables, ['item'], async db => {
      const adb = db;
      const seq = await adb.transaction(async () => {
        const row = new Item();
        row[CORE].setValue('title', 'first');
        return (await row.create())[CORE].column('seq');
      }, { audit: { actor: 'transaction' }, retry: 0 });
      const handle = adb.withSignal(new AbortController().signal);
      await handle.transaction(async () => {
        const row = await new Item().raw('{seq} = ?', seq).get();
        row[CORE].setValue('title', 'second');
        await row.update();
      }, { audit: { actor: 'signal' }, retry: 0 });
      const nested = adb.transaction(async () => { await adb.transaction(async () => {}, { audit: { actor: 'nested' } }); }, { audit: {}, retry: 0 });
      assert.equal(await errorCode(nested), 'CONFIG', 'a nested transaction with an audit');
      const history = await new ItemHistory().connect(db).addAllColumns().orderByRaw('{history_id} ASC').gets();
      assert.deepEqual(history.values().map(h => [
        h[CORE].column('change'), h[CORE].column('previous_audit_seq'), h[CORE].column('seq'), h[CORE].column('title'),
        h[CORE].column('audit_seq'), h[CORE].column('deleted_at') !== null,
      ]), [
        ['insert', null, seq, 'first', 1, false],
        ['update', 1, seq, 'second', 2, false],
      ], 'item_history in history_id order');
      const audits = await new Audit().connect(db).orderByRaw('{seq} ASC').gets();
      assert.deepEqual(audits.values().map(a => [a[CORE].column('seq'), a[CORE].column('actor')]), [[1, 'transaction'], [2, 'signal']], 'audit records');
    });
  },
  // contracts/fixtures/audit_columns.dbs: card는 exclude (secret)로 secret을 빼고, tag는 include (label)로
  // label과 audit column만 기록한다. client가 쓴 insert, update, soft delete를 audit trigger가 고른 column만으로
  // 기록하고, history table에는 기록하는 column만 있다.
  async audit_selected_columns() {
    const { card: Card, tag: Tag, audit: Audit } = auditModels(auditColumnsText);
    await withInstalled(schemaOf(auditColumnsText), auditColumnsTables, ['card', 'tag'], async (db, driver, dsn) => {
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
        const row = await new Card().raw('{seq} = ?', seq).get();
        row[CORE].setValue('title', 'second');
        row[CORE].setValue('secret', 's2');
        await row.update();
      }, { audit: { actor: 'first' }, retry: 0 });
      await adb.transaction(async () => {
        await (await new Card().raw('{seq} = ?', seq).get()).delete();
        const tag = await new Tag().raw('{id} = ?', id).get();
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
  // contracts/fixtures/restore.dbs: unique key 와 exclude 목록을 가진 audit table 과 audit 없는 table 의 soft delete 한
  // 행을 restore 로 되돌린다(tests/restore_case.mjs).
  async soft_delete_restore() {
    await withInstalled(restoreSchema(), restoreTables, ['membership'], db => restoreCase(db));
  },
}, 300_000);
