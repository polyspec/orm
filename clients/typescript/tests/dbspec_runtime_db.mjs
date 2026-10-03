// dbspec runtime model test on SQLite, MySQL and PostgreSQL: a connection
// without a schema path, schema installation from dbspec documents, i16
// values, database defaults, the default select set, the value type of every
// codec stage and dbspec type, and the audit operation id.
// ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name test databases.
//
// Usage: node --test clients/typescript/tests/dbspec_runtime_db.mjs (after the build)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { CORE, Db, Model, OrmError, StyledValue, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { Value as JsonValue, parse as parseJson, stringify as stringifyJson } from '../node_modules/ordered-json/js/index.js';

const require = createRequire(new URL('../package.json', import.meta.url));
const root = new URL('../../..', import.meta.url).pathname;
const work = await mkdtemp(join(tmpdir(), 'orm-ts-dbspec-runtime-'));

const probeText = `dbspec 1 runtime_probe

table probe {
  seq i64 identity
  small i16
  label varchar(32) default 'none'
  note text null
  secret varchar(255) null
  payload text null
  packed bytes null
  day date null
  clock time(3) null
  stamp datetime(3) null
  hidden varchar(16) null
  aes_key_version i32 default 1
  primary key (seq)
  settings {
    select explicit hidden
    codec packed gz
    codec payload ordered_json
    codec secret aes hex
    aes_version aes_key_version
  }
}
`;
const auditText = await readFile(join(root, 'contracts/fixtures/audit.dbs'), 'utf8');

/** A document text's generated schema value: its manifest text and manifestHash. */
function schemaOf(text) {
  const { manifest } = dbspecManifest([parseDbspec(text, {}).document]);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
}

/** Registers the model of a document set and returns a model class per entity. */
function models(text) {
  const parsed = parseDbspec(text, {});
  assert.equal(parsed.diagnostics.length, 0, JSON.stringify(parsed.diagnostics));
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

const { probe: Probe } = models(probeText);
const { item: Item, item_history: ItemHistory } = models(auditText);

async function code(promise) {
  try { await promise; return null; } catch (error) { return error instanceof OrmError ? error.code : String(error); }
}

function mysqlConnection(dsn) {
  const url = new URL(dsn);
  return require('mysql2/promise').createConnection({ user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), socketPath: url.searchParams.get('socket') ?? undefined, host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1) });
}

function postgresClient(dsn) {
  const url = new URL(dsn);
  const { Client } = require('pg');
  return new Client({ host: url.searchParams.get('host') ?? url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1), user: url.username || undefined });
}

const tables = ['probe', 'item', 'item_history'];

/** Drops the tables of this test; each SQLite run starts from a new file. */
async function dropTables(dialect, dsn) {
  if (dialect === 'mysql') {
    const conn = await mysqlConnection(dsn);
    try { for (const t of tables) await conn.query(`DROP TABLE IF EXISTS \`${t}\``); } finally { await conn.end(); }
  } else if (dialect === 'postgres') {
    const client = postgresClient(dsn);
    await client.connect();
    try {
      await client.query('SET client_min_messages = warning');
      for (const t of tables) await client.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
      for (const f of ['item$audit_insert', 'item$audit_update', 'item$audit_delete']) await client.query(`DROP FUNCTION IF EXISTS "${f}"()`);
    } finally { await client.end(); }
  }
}

if (!process.env.ORM_TEST_MYSQL_DSN) throw new Error('ORM_TEST_MYSQL_DSN is required; database tests never skip');
if (!process.env.ORM_TEST_POSTGRES_DSN) throw new Error('ORM_TEST_POSTGRES_DSN is required; database tests never skip');
const targets = [
  ['sqlite', `sqlite://${join(work, 'runtime.sqlite')}`],
  ['mysql', process.env.ORM_TEST_MYSQL_DSN],
  ['postgres', process.env.ORM_TEST_POSTGRES_DSN],
];

after(async () => { await rm(work, { recursive: true, force: true }); });

for (const [dialect, dsn] of targets) {
  let db;
  before(async () => { await dropTables(dialect, dsn); });

  test(`${dialect}: connect takes the DSN and options without a schema path`, { timeout: 30_000 }, async () => {
    db = await Db.connect(dsn, { aesKey: 'probe-aes-key', blindIndexKey: 'probe-blind-key' });
    assert.equal(db.driver, dialect);
  });

  test(`${dialect}: install renders the dbspec documents and repeats without a change`, { timeout: 60_000 }, async () => {
    await db.utils().schema().install(schemaOf(probeText));
    await db.utils().schema().install(schemaOf(probeText));
    await db.utils().schema().install(schemaOf(auditText));
    assert.equal(await new Probe().connect(db).getCount(), 0);
    assert.equal(await new Item().connect(db).getCount(), 0);
  });

  test(`${dialect}: an i16 column reads and writes its whole range`, { timeout: 30_000 }, async () => {
    for (const small of [-32768, 32767]) {
      const row = new Probe().connect(db);
      row[CORE].setValue('small', small);
      const seq = (await row.create())[CORE].column('seq');
      const read = await new Probe().connect(db).raw('{seq} = ?', seq).get();
      assert.equal(read[CORE].column('small'), small);
    }
    for (const invalid of [32768, -32769, 1.5]) {
      assert.equal(await code(Promise.resolve().then(() => new Probe()[CORE].setValue('small', invalid))), 'CODEC_ENCODE', `i16 ${invalid}`);
    }
  });

  test(`${dialect}: an omitted column takes the database default and a required column is checked`, { timeout: 30_000 }, async () => {
    const row = new Probe().connect(db);
    row[CORE].setValue('small', 1);
    const seq = (await row.create())[CORE].column('seq');
    const read = await new Probe().connect(db).raw('{seq} = ?', seq).get();
    assert.equal(read[CORE].column('label'), 'none');
    const missing = new Probe().connect(db);
    missing[CORE].setValue('label', 'x');
    assert.equal(await code(missing.create()), 'IR_INVALID');
  });

  test(`${dialect}: the default select set leaves out only select explicit columns`, { timeout: 30_000 }, async () => {
    const row = new Probe().connect(db);
    row[CORE].setValue('small', 2);
    row[CORE].setValue('note', 'long text');
    row[CORE].setValue('hidden', 'h');
    const seq = (await row.create())[CORE].column('seq');
    const read = await new Probe().connect(db).raw('{seq} = ?', seq).get();
    assert.equal(read[CORE].column('note'), 'long text');
    assert.equal(await code(Promise.resolve().then(() => read[CORE].column('hidden'))), 'COLUMN_UNSELECTED');
    const all = await new Probe().connect(db).addAllColumns().raw('{seq} = ?', seq).get();
    assert.equal(all[CORE].column('hidden'), 'h');
  });

  test(`${dialect}: every codec stage and dbspec type reads its value type`, { timeout: 30_000 }, async () => {
    const row = new Probe().connect(db);
    row[CORE].setValue('small', 3);
    row[CORE].setValue('secret', 'person@example.com');
    row[CORE].setValue('payload', StyledValue.value(parseJson('{"b":1,"a":1.50}')));
    row[CORE].setValue('packed', StyledValue.value('compressed text'));
    row[CORE].setValue('day', '2026-01-02');
    row[CORE].setValue('clock', '12:34:56.789');
    row[CORE].setValue('stamp', '2026-01-02 03:04:05.678');
    const seq = (await row.create())[CORE].column('seq');
    const read = await new Probe().connect(db).raw('{seq} = ?', seq).get();
    assert.equal(read[CORE].column('secret'), 'person@example.com');
    const payload = read[CORE].column('payload');
    assert.ok(payload instanceof StyledValue && payload.kind === 'value' && payload.payload() instanceof JsonValue);
    assert.equal(stringifyJson(payload.payload()), '{"b":1,"a":1.50}');
    const packed = read[CORE].column('packed');
    assert.ok(packed instanceof StyledValue && packed.kind === 'value');
    assert.equal(packed.payload(), 'compressed text');
    assert.equal(read[CORE].column('day'), '2026-01-02');
    assert.equal(read[CORE].column('clock'), '12:34:56.789');
    assert.equal(read[CORE].column('stamp'), '2026-01-02 03:04:05.678');
  });

  test(`${dialect}: an audited write takes the operation id of its transaction`, { timeout: 60_000 }, async () => {
    const item = title => { const m = new Item().connect(db); m[CORE].setValue('title', title); return m; };
    assert.equal(await code(item('a').create()), 'CONFIG');
    assert.equal(await code(db.transaction(async () => { await item('a').create(); }, { retry: 0 })), 'CONFIG');
    const assigned = item('a');
    assigned[CORE].setValue('operation_id', 9);
    assert.equal(await code(db.transaction(async () => { await assigned.create(); }, { operation: 9, retry: 0 })), 'IR_INVALID');
    let seq;
    await db.transaction(async () => { seq = (await item('a').create())[CORE].column('seq'); }, { operation: 7, retry: 0 });
    await db.transaction(async () => {
      const row = await new Item().raw('{seq} = ?', seq).get();
      row[CORE].setValue('title', 'b');
      await row.update();
    }, { operation: 8, retry: 0 });
    await db.transaction(async () => { await (await new Item().raw('{seq} = ?', seq).get()).delete(); }, { operation: 9, retry: 0 });
    const history = await new ItemHistory().connect(db).addAllColumns().orderByRaw('{history_id} ASC').gets();
    const rows = history.values().map(h => [h[CORE].column('change'), h[CORE].column('previous_operation_id'), h[CORE].column('operation_id'), h[CORE].column('title'), h[CORE].column('deleted_at') !== null]);
    assert.deepEqual(rows, [['insert', null, 7, 'a', false], ['update', 7, 8, 'b', false], ['update', 8, 9, 'b', true]]);
    assert.equal(await new Item().connect(db).getCount(), 0);
  });

  test(`${dialect}: close and drop the tables`, { timeout: 30_000 }, async () => {
    await db.close();
    await dropTables(dialect, dsn);
  });
}
