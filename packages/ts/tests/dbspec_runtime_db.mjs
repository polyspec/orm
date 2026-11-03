// dbspec runtime model test on SQLite, MySQL and PostgreSQL: a connection
// without a schema path, schema installation from dbspec documents, i16
// values, database defaults, the default select set, the value type of every
// codec stage and dbspec type. Each dialect runs
// on a case database of its own on the servers of ORM_TEST_MYSQL_DSN and
// ORM_TEST_POSTGRES_DSN, or a new SQLite file (case-database.mjs).
//
// Usage: node --test packages/ts/tests/dbspec_runtime_db.mjs (after the build)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after } from 'node:test';
import { caseTest } from '../../../tests/testcase.mts';
import { createCaseDatabase } from './case-database.mjs';
import { CORE, Db, OrmError, StyledValue } from '../dist/index.js';
import { Value as JsonValue, parse as parseJson, stringify as stringifyJson } from '@polyspec/ordered-json';
import { models } from './registered_models.mjs';
import { schemaOf } from './schema_of.mjs';

const root = new URL('../../..', import.meta.url).pathname;

const probeText = `dbspec 1 runtime_probe

table probe {
  seq i64 identity
  small i16
  wide i64
  ratio f64
  active bool
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

const { probe: Probe } = models(probeText);
const { item: Item } = models(auditText);

async function code(promise) {
  try { await promise; return null; } catch (error) { return error instanceof OrmError ? error.code : String(error); }
}

async function assertProbeColumn(db, values, column, expected) {
  const row = new Probe().connect(db);
  for (const [name, value] of Object.entries(values)) row[CORE].setValue(name, value);
  const seq = (await row.create())[CORE].column('seq');
  const read = await new Probe().connect(db).seq(seq).get();
  assert.equal(read[CORE].column(column), expected);
}

if (!process.env.ORM_TEST_MYSQL_DSN) throw new Error('ORM_TEST_MYSQL_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers');
if (!process.env.ORM_TEST_POSTGRES_DSN) throw new Error('ORM_TEST_POSTGRES_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers');

// Deadline of each case: a few connections or statements take 30 s, and writes that go through schema install and the audit trigger
// run DDL, so they take 60 s.
// For each dialect, the first case creates the case database and the last case drops it. Even if an earlier case fails, node:test
// still runs the last case. If the process ends before that, after drops the leftover database and
// fails if a database is still there.
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

  // Requirements: DBS-119.
  caseTest(`${dialect}: connect takes the DSN and options without a schema path`, 30_000, async ({ step }) => {
    database = await createCaseDatabase(dialect, step);
    db = await Db.connect(database.dsn, { aesKey: 'probe-aes-key', blindIndexKey: 'probe-blind-key' });
    assert.equal(db.driver, dialect);
  });

  caseTest(`${dialect}: install renders the dbspec documents and repeats without a change`, 60_000, async () => {
    await db.utils().schema().install(schemaOf(probeText));
    await db.utils().schema().install(schemaOf(probeText));
    await db.utils().schema().install(schemaOf(auditText));
    assert.equal(await new Probe().connect(db).getCount(), 0);
    assert.equal(await new Item().connect(db).getCount(), 0);
  });

  caseTest(`${dialect}: the default select set leaves out only select explicit columns`, 30_000, async () => {
    const row = new Probe().connect(db);
    row[CORE].setValue('small', 2);
    row[CORE].setValue('wide', 8);
    row[CORE].setValue('ratio', 2.0);
    row[CORE].setValue('active', true);
    row[CORE].setValue('note', 'long text');
    row[CORE].setValue('hidden', 'h');
    const seq = (await row.create())[CORE].column('seq');
    const read = await new Probe().connect(db).seq(seq).get();
    assert.equal(read[CORE].column('note'), 'long text');
    assert.equal(await code(Promise.resolve().then(() => read[CORE].column('hidden'))), 'COLUMN_UNSELECTED');
    const all = await new Probe().connect(db).addAllColumns().seq(seq).get();
    assert.equal(all[CORE].column('hidden'), 'h');
  });

  // Requirements: INT-99.
  caseTest(`${dialect}: every codec stage and dbspec type reads its value type`, 30_000, async () => {
    const row = new Probe().connect(db);
    row[CORE].setValue('small', 3);
    row[CORE].setValue('wide', 9);
    row[CORE].setValue('ratio', 2.5);
    row[CORE].setValue('active', true);
    row[CORE].setValue('secret', 'person@example.com');
    row[CORE].setValue('payload', StyledValue.value(parseJson('{"b":1,"a":1.50}')));
    row[CORE].setValue('packed', StyledValue.value('compressed text'));
    row[CORE].setValue('day', '2026-01-02');
    row[CORE].setValue('clock', '12:34:56.789');
    row[CORE].setValue('stamp', '2026-01-02 03:04:05.678');
    const seq = (await row.create())[CORE].column('seq');
    const read = await new Probe().connect(db).seq(seq).get();
    const payload = read[CORE].column('payload');
    assert.ok(payload instanceof StyledValue && payload.kind === 'value' && payload.payload() instanceof JsonValue);
    assert.equal(stringifyJson(payload.payload()), '{"b":1,"a":1.50}');
    assert.equal(read[CORE].column('clock'), '12:34:56.789');
    assert.equal(read[CORE].column('stamp'), '2026-01-02 03:04:05.678');
  });

  // Requirements: INT-98.
  caseTest(`${dialect}: invalid stored numeric and boolean cells fail typed reads`, 30_000, async () => {
    const row = new Probe().connect(db);
    row[CORE].setValue('small', 5);
    row[CORE].setValue('wide', 11);
    row[CORE].setValue('ratio', 4.5);
    row[CORE].setValue('active', true);
    const seq = (await row.create())[CORE].column('seq');
    if (dialect === 'mysql') {
      await db.pool.execute('ALTER TABLE probe MODIFY wide BIGINT UNSIGNED', [], undefined, () => undefined);
      await db.pool.execute('UPDATE probe SET wide = 18446744073709551615 WHERE seq = ?', [seq], undefined, () => undefined);
    } else if (dialect === 'postgres') {
      await db.pool.execute("UPDATE probe SET ratio = 'NaN'::double precision WHERE seq = $1", [seq], undefined, () => undefined);
    } else {
      await db.pool.execute('PRAGMA ignore_check_constraints = ON', [], undefined, () => undefined);
      try {
        await db.pool.execute('UPDATE probe SET wide = ? WHERE seq = ?', ['not-an-integer', seq], undefined, () => undefined);
      } finally {
        await db.pool.execute('PRAGMA ignore_check_constraints = OFF', [], undefined, () => undefined);
      }
    }
    const invalidRead = new Probe().connect(db).seq(seq);
    invalidRead[CORE].addColumn(dialect === 'postgres' ? 'ratio' : 'wide');
    await assert.rejects(
      invalidRead.get(),
      error => error instanceof OrmError && error.code === 'CODEC_DECODE',
    );
    if (dialect === 'mysql') {
      await db.pool.execute('UPDATE probe SET wide = 12 WHERE seq = ?', [seq], undefined, () => undefined);
      // This disposable case database needs an out-of-domain stored bool to exercise the decoder, not the CHECK constraint.
      await db.pool.execute('ALTER TABLE probe DROP CHECK `probe$active`', [], undefined, () => undefined);
      await db.pool.execute('UPDATE probe SET active = 2 WHERE seq = ?', [seq], undefined, () => undefined);
      const invalidBooleanRead = new Probe().connect(db).seq(seq);
      invalidBooleanRead[CORE].addColumn('active');
      await assert.rejects(
        invalidBooleanRead.get(),
        error => error instanceof OrmError && error.code === 'CODEC_DECODE',
      );
    }
  });


  caseTest(`${dialect}: close and drop the case database`, 30_000, async ({ step }) => {
    const left = database;
    database = undefined;
    try { await db?.close(); } finally { await left?.drop(step); }
  });
}
