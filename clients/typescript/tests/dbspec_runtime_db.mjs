// dbspec runtime model test on SQLite, MySQL and PostgreSQL: a connection
// without a schema path, schema installation from dbspec documents, i16
// values, database defaults, the default select set, the value type of every
// codec stage and dbspec type, and the audit record of a transaction. Each dialect runs
// on a case database of its own on the servers of ORM_TEST_MYSQL_DSN and
// ORM_TEST_POSTGRES_DSN, or a new SQLite file (case-database.mjs).
//
// Usage: node --test clients/typescript/tests/dbspec_runtime_db.mjs (after the build)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after } from 'node:test';
import { caseTest } from '../../../tests/testcase.mjs';
import { createCaseDatabase } from './case-database.mjs';
import { auditCase, auditSource, restoreCase, restoreSchema } from './restore_case.mjs';
import { CORE, Db, Model, OrmError, StyledValue, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { Value as JsonValue, parse as parseJson, stringify as stringifyJson } from '../node_modules/ordered-json/js/index.js';

const root = new URL('../../..', import.meta.url).pathname;

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
const { item: Item } = models(auditText);

async function code(promise) {
  try { await promise; return null; } catch (error) { return error instanceof OrmError ? error.code : String(error); }
}

if (!process.env.ORM_TEST_MYSQL_DSN) throw new Error('ORM_TEST_MYSQL_DSN is required; database tests never skip');
if (!process.env.ORM_TEST_POSTGRES_DSN) throw new Error('ORM_TEST_POSTGRES_DSN is required; database tests never skip');

// 각 case의 기한: 연결이나 statement 몇 개는 30 s, schema 설치와 audit trigger를 거치는 쓰기는
// DDL을 실행하므로 60 s다.
// dialect마다 첫 case가 case database를 만들고 마지막 case가 지운다. 앞 case가 실패해도 node:test는
// 마지막 case를 실행한다. process가 그 전에 끝나는 경우에는 after가 남은 database를 지우고, 지운
// database가 있으면 실패한다.
for (const dialect of ['sqlite', 'mysql', 'postgres']) {
  let db;
  let database;
  after(async () => {
    if (database === undefined) return;
    const left = database;
    database = undefined;
    await db?.close();
    await left.drop(text => console.log(`STEP ${dialect}: after the cases: ${text}`));
    throw new Error(`${dialect}: case database ${left.name} was left by the cases and is dropped`);
  });

  caseTest(`${dialect}: connect takes the DSN and options without a schema path`, 30_000, async ({ step }) => {
    database = await createCaseDatabase(dialect, step);
    db = await Db.connect(database.dsn, { aesKey: 'probe-aes-key', blindIndexKey: 'probe-blind-key', auditSource: auditSource('default') });
    assert.equal(db.driver, dialect);
  });

  caseTest(`${dialect}: install renders the dbspec documents and repeats without a change`, 60_000, async () => {
    await db.utils().schema().install(schemaOf(probeText));
    await db.utils().schema().install(schemaOf(probeText));
    await db.utils().schema().install(schemaOf(auditText));
    assert.equal(await new Probe().connect(db).getCount(), 0);
    assert.equal(await new Item().connect(db).getCount(), 0);
  });

  caseTest(`${dialect}: an i16 column reads and writes its whole range`, 30_000, async () => {
    for (const small of [-32768, 32767]) {
      const row = new Probe().connect(db);
      row[CORE].setValue('small', small);
      const seq = (await row.create())[CORE].column('seq');
      const read = await new Probe().connect(db).seq(seq).get();
      assert.equal(read[CORE].column('small'), small);
    }
    for (const invalid of [32768, -32769, 1.5]) {
      assert.equal(await code(Promise.resolve().then(() => new Probe()[CORE].setValue('small', invalid))), 'CODEC_ENCODE', `i16 ${invalid}`);
    }
  });

  caseTest(`${dialect}: an omitted column takes the database default and a required column is checked`, 30_000, async () => {
    const row = new Probe().connect(db);
    row[CORE].setValue('small', 1);
    const seq = (await row.create())[CORE].column('seq');
    const read = await new Probe().connect(db).seq(seq).get();
    assert.equal(read[CORE].column('label'), 'none');
    const missing = new Probe().connect(db);
    missing[CORE].setValue('label', 'x');
    assert.equal(await code(missing.create()), 'IR_INVALID');
  });

  caseTest(`${dialect}: the default select set leaves out only select explicit columns`, 30_000, async () => {
    const row = new Probe().connect(db);
    row[CORE].setValue('small', 2);
    row[CORE].setValue('note', 'long text');
    row[CORE].setValue('hidden', 'h');
    const seq = (await row.create())[CORE].column('seq');
    const read = await new Probe().connect(db).seq(seq).get();
    assert.equal(read[CORE].column('note'), 'long text');
    assert.equal(await code(Promise.resolve().then(() => read[CORE].column('hidden'))), 'COLUMN_UNSELECTED');
    const all = await new Probe().connect(db).addAllColumns().seq(seq).get();
    assert.equal(all[CORE].column('hidden'), 'h');
  });

  caseTest(`${dialect}: every codec stage and dbspec type reads its value type`, 30_000, async () => {
    const row = new Probe().connect(db);
    row[CORE].setValue('small', 3);
    row[CORE].setValue('secret', 'person@example.com');
    row[CORE].setValue('payload', StyledValue.value(parseJson('{"b":1,"a":1.50}')));
    row[CORE].setValue('packed', StyledValue.value('compressed text'));
    row[CORE].setValue('day', '2026-01-02');
    row[CORE].setValue('clock', '12:34:56.789');
    row[CORE].setValue('stamp', '2026-01-02 03:04:05.678');
    const seq = (await row.create())[CORE].column('seq');
    const read = await new Probe().connect(db).seq(seq).get();
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

  // audit 기록을 받은 transaction 의 write 를 확인한다(tests/restore_case.mjs). audit.dbs 는 앞 case 가 설치했다.
  caseTest(`${dialect}: an audited write takes the audit record of its transaction`, 60_000, async () => {
    await auditCase(db, dialect, database.dsn);
  });

  // soft delete 한 행을 unique key 나 primary key 로 restore 한다(tests/restore_case.mjs). restore.dbs 는 audit.dbs 와
  // 같은 이름의 audit table 을 가지므로 자기 case database 에 설치한다.
  caseTest(`${dialect}: restore brings back a soft-deleted row by its primary key or a unique key`, 60_000, async ({ step }) => {
    const own = await createCaseDatabase(dialect, step);
    let restoreDb;
    try {
      restoreDb = await Db.connect(own.dsn, { auditSource: auditSource('default') });
      await restoreDb.utils().schema().install(restoreSchema());
      await restoreCase(restoreDb);
    } finally {
      try { await restoreDb?.close(); } finally { await own.drop(step); }
    }
  });

  caseTest(`${dialect}: close and drop the case database`, 30_000, async ({ step }) => {
    const left = database;
    database = undefined;
    try { await db?.close(); } finally { await left?.drop(step); }
  });
}
