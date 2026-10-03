// audit_triggers coverage: contracts/fixtures/audit.dbs 을 schema install 로 설치하고
// clients/go/orm/audit_operation_test.go 와 같은 순서로 쓴 뒤 trigger 가 남긴 item_history 를
// 확인한다. 끝에 두 table 과 PostgreSQL trigger function 을 지워 database 를 처음 상태로 돌린다.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CORE, Db, Model, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { errorCode, featureDatabase, nativeQuery, repositoryRoot, runCases, tableExists, withCleanup } from './coverage_case.mjs';

const auditText = await readFile(join(repositoryRoot, 'contracts/fixtures/audit.dbs'), 'utf8');
const auditColumnsText = await readFile(join(repositoryRoot, 'contracts/fixtures/audit_columns.dbs'), 'utf8');

/** A document text's generated schema value: its manifest text and manifestHash. */
function schemaOf(text) {
  const { manifest } = dbspecManifest([parseDbspec(text, {}).document]);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
}

/** Registers the model of the audit document and returns a model class per entity. */
function auditModels(text = auditText) {
  const parsed = parseDbspec(text, {});
  assert.deepEqual(parsed.diagnostics, [], 'audit.dbs parses');
  const { manifest, diagnostics } = dbspecManifest([parsed.document]);
  assert.deepEqual(diagnostics, [], 'audit.dbs has a manifest');
  const model = registerModel(manifest.manifestText, manifest.manifestHash);
  const out = {};
  for (const entity of model.entities.values()) {
    const cls = class extends Model {};
    cls.entity = { model, entity, create: core => new cls(core) };
    out[entity.name] = cls;
  }
  return out;
}

/** Drops the audit tables and, on PostgreSQL, their trigger functions. */
async function dropAudit(driver, dsn) {
  const quote = driver === 'mysql' ? name => `\`${name}\`` : name => `"${name}"`;
  const statements = ['item', 'item_history'].map(t => `DROP TABLE IF EXISTS ${quote(t)}`);
  if (driver === 'postgres') {
    for (const f of ['item$audit_insert', 'item$audit_update', 'item$audit_delete']) statements.push(`DROP FUNCTION IF EXISTS "${f}"()`);
  }
  await nativeQuery(driver, dsn, statements);
}

/** Drops the audit_columns tables and, on PostgreSQL, their trigger functions. */
async function dropAuditColumns(driver, dsn) {
  const quote = driver === 'mysql' ? name => `\`${name}\`` : name => `"${name}"`;
  const statements = ['card_history', 'card', 'tag_history', 'tag'].map(t => `DROP TABLE IF EXISTS ${quote(t)}`);
  if (driver === 'postgres') {
    for (const t of ['card', 'tag']) {
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

await runCases('coverage_audit_triggers.mjs', {
  async audit_history() {
    const { driver, dsn } = featureDatabase();
    for (const table of ['item', 'item_history']) {
      assert.equal(await tableExists(driver, dsn, table), false, `table ${table} does not exist before the case`);
    }
    const { item: Item, item_history: ItemHistory } = auditModels();
    const db = await Db.connect(dsn);
    try {
      assert.equal(db.driver, driver);
      await withCleanup(async () => {
        await db.utils().schema().install(schemaOf(auditText));
        const item = title => { const m = new Item(); m[CORE].setValue('title', title); return m; };
        const byKey = seq => new Item().raw('{seq} = ?', seq);
        assert.equal(await errorCode(item('outside').connect(db).create()), 'CONFIG', 'insert without an operation id');
        let seq;
        await db.transaction(async () => {
          seq = (await item('first').create())[CORE].column('seq');
          // 중첩 transaction 은 바깥 operation id 를 쓴다.
          await db.transaction(async () => {
            const row = await byKey(seq).get();
            row[CORE].setValue('title', 'second');
            await row.update();
          }, { retry: 0 });
        }, { operation: 7, retry: 0 });
        const titled = await byKey(seq).connect(db).get();
        titled[CORE].setValue('title', 'third');
        assert.equal(await errorCode(titled.update()), 'CONFIG', 'update without an operation id');
        await db.transaction(async () => { await (await byKey(seq).get()).delete(); }, { operation: 8, retry: 0 });
        const history = await new ItemHistory().connect(db).addAllColumns().orderByRaw('{history_id} ASC').gets();
        const rows = history.values().map(h => [
          h[CORE].column('change'), h[CORE].column('previous_operation_id'), h[CORE].column('seq'),
          h[CORE].column('title'), h[CORE].column('operation_id'), h[CORE].column('deleted_at') !== null,
        ]);
        assert.deepEqual(rows, [
          ['insert', null, seq, 'first', 7, false],
          ['update', 7, seq, 'second', 7, false],
          ['update', 7, seq, 'second', 8, true],
        ], 'item_history in history_id order');
      }, () => dropAudit(driver, dsn));
    } finally { await db.close(); }
    for (const table of ['item', 'item_history']) {
      assert.equal(await tableExists(driver, dsn, table), false, `table ${table} is dropped after the case`);
    }
  },
  // contracts/fixtures/audit_columns.dbs: card는 exclude (secret)로 secret을 빼고, tag는 include (label)로
  // label과 operation column만 기록한다. client가 쓴 insert, update, soft delete를 audit trigger가 고른 column만으로
  // 기록하고, history table에는 기록하는 column만 있다. 끝에 table과 PostgreSQL trigger function을 지운다.
  async audit_selected_columns() {
    const { driver, dsn } = featureDatabase();
    const { card: Card, tag: Tag } = auditModels(auditColumnsText);
    const db = await Db.connect(dsn);
    try {
      await withCleanup(async () => {
        await db.utils().schema().install(schemaOf(auditColumnsText));
        let seq;
        let id;
        await db.transaction(async () => {
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
        }, { operation: 7, retry: 0 });
        await db.transaction(async () => {
          await (await new Card().raw('{seq} = ?', seq).get()).delete();
          const tag = await new Tag().raw('{id} = ?', id).get();
          tag[CORE].setValue('color', 'blue');
          await tag.update();
        }, { operation: 8, retry: 0 });
        const change = driver === 'mysql' ? '`change`' : '"change"';
        const cards = await textRows(driver, dsn, 'SELECT * FROM card_history ORDER BY history_id');
        assert.deepEqual(cards.columns, ['history_id', 'change', 'previous_operation_id', 'seq', 'title', 'operation_id', 'deleted_at'], 'card_history columns');
        const cardRows = await textRows(driver, dsn, `SELECT ${change}, previous_operation_id, seq, title, operation_id, CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END AS state FROM card_history ORDER BY history_id`);
        assert.deepEqual(cardRows.rows, [
          ['insert', 'NULL', String(seq), 'first', '7', 'live'],
          ['update', '7', String(seq), 'second', '7', 'live'],
          ['update', '7', String(seq), 'second', '8', 'deleted'],
        ], 'card_history in history_id order');
        const tags = await textRows(driver, dsn, 'SELECT * FROM tag_history ORDER BY history_id');
        assert.deepEqual(tags.columns, ['history_id', 'change', 'previous_operation_id', 'label', 'operation_id'], 'tag_history columns');
        const tagRows = await textRows(driver, dsn, `SELECT ${change}, previous_operation_id, label, operation_id FROM tag_history ORDER BY history_id`);
        assert.deepEqual(tagRows.rows, [['insert', 'NULL', 'x', '7'], ['update', '7', 'x', '8']], 'tag_history in history_id order');
      }, () => dropAuditColumns(driver, dsn));
    } finally { await db.close(); }
    for (const table of ['card', 'card_history', 'tag', 'tag_history']) {
      assert.equal(await tableExists(driver, dsn, table), false, `table ${table} is dropped after the case`);
    }
  },
}, 300_000);
