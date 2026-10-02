// The migration ledger orm_schema_migrations on SQLite, MySQL and PostgreSQL:
// `orm-gen migrate` stores its times with six fraction digits, and a ledger
// whose time columns keep whole seconds fails with MIGRATION_HISTORY_PRECISION
// and stays unchanged. ORM_TOOLS_MYSQL_DSN and ORM_TOOLS_POSTGRES_DSN name
// dedicated databases; the test fails when either is unset and drops every
// table in them.
//
// Usage: node clients/typescript/tests/ledger.mjs [case ...] (after npm run typescript:build)
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openToolDb } from '../dist/tools/db.js';

const root = new URL('../../..', import.meta.url).pathname;
const tsBin = join(root, 'clients/typescript/dist/bin/orm-gen.js');
const work = await mkdtemp(join(tmpdir(), 'orm-ts-ledger-'));
const CASE_DEADLINE_MS = 60_000;
let failures = 0;
let current = '';
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}

const schemas = {
  v1: 'erDiagram\n  ledger_probe {\n    bigint seq PK\n  }\n',
  v2: 'erDiagram\n  ledger_probe {\n    bigint seq PK\n    varchar(32) note "?"\n  }\n',
  v3: 'erDiagram\n  ledger_probe {\n    bigint seq PK\n    varchar(32) note "?"\n    varchar(32) label "?"\n  }\n',
};
for (const [name, text] of Object.entries(schemas)) await writeFile(join(work, `${name}.mmd`), text);

function tool(args) {
  return new Promise(resolve => {
    execFile(process.execPath, [tsBin, ...args], { cwd: work, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

async function withDb(dsn, fn) {
  const { db } = await openToolDb(dsn);
  try { return await fn(db); } finally { await db.close(); }
}

async function wipe(driver, dsn) {
  await withDb(dsn, async db => {
    const q = driver === 'mysql' ? 'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()'
      : driver === 'postgres' ? 'SELECT tablename FROM pg_tables WHERE schemaname = current_schema()'
        : "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'";
    for (const [table] of await db.query(q)) {
      await db.exec(driver === 'mysql' ? `DROP TABLE \`${table}\`` : `DROP TABLE IF EXISTS "${table}"${driver === 'postgres' ? ' CASCADE' : ''}`);
    }
  });
}

/** Every stored ledger time as text; a NULL finishing time is "NULL". */
async function ledgerTimes(driver, dsn) {
  const q = driver === 'mysql' ? 'SELECT migration_id, CAST(started_at AS CHAR), CAST(finished_at AS CHAR) FROM orm_schema_migrations ORDER BY migration_id'
    : driver === 'postgres' ? "SELECT migration_id, to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'), to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') FROM orm_schema_migrations ORDER BY migration_id"
      : 'SELECT migration_id, started_at, finished_at FROM orm_schema_migrations ORDER BY migration_id';
  return withDb(dsn, async db => (await db.query(q)).map(row => row.map(v => v === null ? 'NULL' : String(v))));
}

/** The stored definition of the ledger columns. */
async function ledgerDefinition(driver, dsn) {
  const q = driver === 'mysql' ? "SELECT GROUP_CONCAT(CONCAT(COLUMN_NAME, ' ', COLUMN_TYPE) ORDER BY COLUMN_NAME) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orm_schema_migrations'"
    : driver === 'postgres' ? "SELECT string_agg(attname || ' ' || format_type(atttypid, atttypmod), ',' ORDER BY attname) FROM pg_attribute WHERE attrelid = to_regclass('orm_schema_migrations') AND attnum > 0 AND NOT attisdropped"
      : "SELECT sql FROM sqlite_master WHERE type='table' AND name='orm_schema_migrations'";
  return withDb(dsn, async db => String((await db.query(q))[0][0]));
}

/** Three migrations store six fraction digits in every ledger time, at least one not 000000. */
async function ledgerMicroseconds(driver, dsn) {
  for (const [i, name] of ['v1', 'v2', 'v3'].entries()) {
    const out = await tool(['migrate', '--dsn', dsn, '--schema', join(work, `${name}.mmd`), '--migration-id', `m${i + 1}`, '--log-dir', join(work, `logs-${driver}`)]);
    check(out.status === 0 && out.stdout.includes('status=applied'), `migrate ${name}: ${out.stdout}${out.stderr}`);
  }
  const rows = await ledgerTimes(driver, dsn);
  check(rows.length === 3, `ledger rows: ${JSON.stringify(rows)}`);
  let fractions = 0;
  for (const row of rows) {
    for (const v of row.slice(1)) {
      check(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(v), `ledger time ${v} of ${row[0]} has no six fraction digits`);
      if (!v.endsWith('.000000')) fractions++;
    }
  }
  check(fractions > 0, `ledger times have no fraction: ${JSON.stringify(rows)}`);
}

const wholeSecondLedger = {
  mysql: 'CREATE TABLE orm_schema_migrations (migration_id varchar(191) NOT NULL PRIMARY KEY, name varchar(255) NOT NULL, from_schema_hash varchar(128) NOT NULL, to_schema_hash varchar(128) NOT NULL, plan_checksum varchar(128) NOT NULL, status varchar(32) NOT NULL, operations int NOT NULL, error_detail text NOT NULL, started_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamp NULL)',
  postgres: 'CREATE TABLE orm_schema_migrations (migration_id text PRIMARY KEY, name text NOT NULL, from_schema_hash text NOT NULL, to_schema_hash text NOT NULL, plan_checksum text NOT NULL, status text NOT NULL, operations integer NOT NULL, error_detail text NOT NULL, started_at timestamptz(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamptz(0) NULL)',
  sqlite: 'CREATE TABLE orm_schema_migrations (migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, from_schema_hash TEXT NOT NULL, to_schema_hash TEXT NOT NULL, plan_checksum TEXT NOT NULL, status TEXT NOT NULL, operations INTEGER NOT NULL, error_detail TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT NULL)',
};

/** A ledger with whole-second time columns fails the migration and stays unchanged. */
async function ledgerWholeSeconds(driver, dsn) {
  await withDb(dsn, async db => {
    await db.exec(wholeSecondLedger[driver]);
    await db.exec("INSERT INTO orm_schema_migrations (migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations,error_detail,started_at,finished_at) VALUES ('old','old','from','to','sum','applied',1,'','2026-01-02 03:04:05','2026-01-02 03:04:06')");
  });
  const before = await ledgerTimes(driver, dsn);
  const definition = await ledgerDefinition(driver, dsn);
  const out = await tool(['migrate', '--dsn', dsn, '--schema', join(work, 'v1.mmd'), '--migration-id', 'm1', '--log-dir', join(work, `logs-${driver}`)]);
  check(out.status !== 0 && out.stderr.includes(`MIGRATION_HISTORY_PRECISION: driver=${driver} column=started_at`), `whole-second ledger: exit ${out.status} ${out.stdout}${out.stderr}`);
  const after = await ledgerTimes(driver, dsn);
  check(JSON.stringify(after) === JSON.stringify(before), `ledger rows changed: ${JSON.stringify(after)}`);
  const changed = await ledgerDefinition(driver, dsn);
  check(changed === definition, `ledger definition changed: ${changed}`);
  const q = driver === 'mysql' ? "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ledger_probe'"
    : driver === 'postgres' ? "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename = 'ledger_probe'"
      : "SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_probe'";
  const tables = await withDb(dsn, db => db.query(q));
  check(tables.length === 0, 'the migration created ledger_probe');
}

const earlierLedger = { mysql: wholeSecondLedger.mysql, postgres: 'CREATE TABLE orm_schema_migrations (migration_id text PRIMARY KEY, name text NOT NULL, from_schema_hash text NOT NULL, to_schema_hash text NOT NULL, plan_checksum text NOT NULL, status text NOT NULL, operations integer NOT NULL, error_detail text NOT NULL, started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at timestamptz NULL)', sqlite: wholeSecondLedger.sqlite };

/** The conversion of an earlier ledger in docs/usage.md; an earlier PostgreSQL ledger needs none. */
const ledgerConversion = {
  mysql: ['ALTER TABLE orm_schema_migrations MODIFY started_at timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), MODIFY finished_at timestamp(6) NULL'],
  postgres: [],
  sqlite: [
    'BEGIN',
    'ALTER TABLE orm_schema_migrations RENAME TO orm_schema_migrations_seconds',
    'CREATE TABLE orm_schema_migrations (migration_id TEXT PRIMARY KEY, name TEXT NOT NULL, from_schema_hash TEXT NOT NULL, to_schema_hash TEXT NOT NULL, plan_checksum TEXT NOT NULL, status TEXT NOT NULL, operations INTEGER NOT NULL, error_detail TEXT NOT NULL, started_at TEXT NOT NULL CHECK (started_at GLOB \'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]\'), finished_at TEXT NULL CHECK (finished_at GLOB \'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9][0-9][0-9][0-9]\'))',
    'INSERT INTO orm_schema_migrations SELECT migration_id, name, from_schema_hash, to_schema_hash, plan_checksum, status, operations, error_detail, started_at || \'.000000\', finished_at || \'.000000\' FROM orm_schema_migrations_seconds',
    'DROP TABLE orm_schema_migrations_seconds',
    'COMMIT',
  ],
};

/**
 * An earlier ledger converted with the statements of docs/usage.md, and an
 * earlier PostgreSQL ledger as it is, keep their rows with the fraction 000000
 * and take a new migration with six fraction digits.
 */
async function ledgerEarlier(driver, dsn) {
  await withDb(dsn, async db => {
    for (const q of [earlierLedger[driver], 'INSERT INTO orm_schema_migrations (migration_id,name,from_schema_hash,to_schema_hash,plan_checksum,status,operations,error_detail,started_at,finished_at) VALUES (\'old\',\'old\',\'from\',\'to\',\'sum\',\'applied\',1,\'\',\'2026-01-02 03:04:05\',\'2026-01-02 03:04:06\')', ...ledgerConversion[driver]]) await db.exec(q);
  });
  const out = await tool(['migrate', '--dsn', dsn, '--schema', join(work, 'v1.mmd'), '--migration-id', 'm1', '--log-dir', join(work, `logs-${driver}`)]);
  check(out.status === 0 && out.stdout.includes('status=applied'), `migrate after conversion: ${out.stdout}${out.stderr}`);
  const rows = await ledgerTimes(driver, dsn);
  check(rows.length === 2 && rows[1][0] === 'old', `ledger rows: ${JSON.stringify(rows)}`);
  for (const row of rows) {
    for (const v of row.slice(1)) check(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(v), `ledger time ${v} of ${row[0]} has no six fraction digits`);
  }
  check(rows[1]?.[1]?.endsWith(':05.000000') && rows[1]?.[2]?.endsWith(':06.000000'), `earlier row lost its seconds: ${JSON.stringify(rows[1])}`);
}

const cases = {
  migration_ledger_microseconds: ledgerMicroseconds,
  migration_ledger_whole_seconds: ledgerWholeSeconds,
  migration_ledger_earlier: ledgerEarlier,
};
const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(cases);
const targets = { sqlite: `sqlite://${join(work, 'ledger.sqlite')}` };
for (const [driver, env] of [['mysql', 'ORM_TOOLS_MYSQL_DSN'], ['postgres', 'ORM_TOOLS_POSTGRES_DSN']]) {
  const value = process.env[env];
  if (!value) throw new Error(`${env} is required; database tests never skip`);
  targets[driver] = value;
}
try {
  for (const name of selected) {
    const run = cases[name];
    if (run === undefined) throw new Error(`unknown case ${name}`);
    const caseBefore = failures;
    for (const [driver, dsn] of Object.entries(targets)) {
      const before = failures;
      current = `${name}/${driver}`;
      const start = performance.now();
      console.log(`RUN  ${current}`);
      let timer;
      try {
        await wipe(driver, dsn);
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${CASE_DEADLINE_MS} ms`)), CASE_DEADLINE_MS); });
        await Promise.race([run(driver, dsn), deadline]);
      } catch (error) {
        failures++;
        console.error(`FAIL ${current}: ${error?.stack ?? error}`);
      } finally {
        clearTimeout(timer);
        await wipe(driver, dsn);
      }
      console.log(`${failures === before ? 'ok  ' : 'FAIL'} ${current} ${((performance.now() - start) / 1000).toFixed(3)}s`);
    }
    if (failures === caseBefore) console.log(`CASE ${name} PASS`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
if (failures > 0) {
  console.error(`typescript ledger test: ${failures} failures`);
  process.exit(1);
}
console.log(`typescript ledger test: ${selected.length} cases on ${Object.keys(targets).length} databases passed`);
