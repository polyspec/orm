// The clock of datetime(6) columns, on SQLite, MySQL and PostgreSQL, with the
// fixtures contracts/fixtures/clock.dbspec and clock_mark.dbspec. An insert
// that omits created_ts (default now) takes the database clock on MySQL and
// PostgreSQL and binds the client clock of the `now` slot on SQLite, whose
// database clock has milliseconds only; either way the stored fraction holds
// microseconds. A clock with millisecond resolution stores every value as
// `.mmm000`. ORM_TEST_MYSQL_DSN
// and ORM_TEST_POSTGRES_DSN name test databases; the test fails when either
// is unset.
//
// Usage: node clients/typescript/tests/clock.mjs [case ...] (after npm run typescript:build)
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CORE, Db, Model, dbspecManifest, orm, parseDbspec, registerModel } from '../dist/index.js';

const require = createRequire(new URL('../package.json', import.meta.url));
const clockText = await readFile(new URL('../../../contracts/fixtures/clock.dbspec', import.meta.url), 'utf8');
const markText = await readFile(new URL('../../../contracts/fixtures/clock_mark.dbspec', import.meta.url), 'utf8');
const work = await mkdtemp(join(tmpdir(), 'orm-ts-clock-'));
const CASE_DEADLINE_MS = 30_000;
let failures = 0;
let current = '';
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}

/** Registers the model of a document set as generated code does and returns a model class per entity. */
function models(text) {
  const parsed = parseDbspec(text, {});
  if (parsed.document === null) throw new Error(JSON.stringify(parsed.diagnostics));
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
const { clock_event: ClockEvent } = models(clockText);
const { clock_mark: ClockMark } = models(markText);

/** Drops the test table with the database driver; SQLite uses a new file per run. */
async function dropTable(driver, dsn) {
  const url = new URL(dsn);
  if (driver === 'mysql') {
    const conn = await require('mysql2/promise').createConnection({ user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1) });
    try { await conn.query('DROP TABLE IF EXISTS clock_event'); await conn.query('DROP TABLE IF EXISTS clock_mark'); } finally { await conn.end(); }
  } else if (driver === 'postgres') {
    const { Client } = require('pg');
    const client = new Client({ host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1), user: url.username || undefined, password: decodeURIComponent(url.password) || undefined });
    await client.connect();
    try { await client.query('DROP TABLE IF EXISTS clock_event'); await client.query('DROP TABLE IF EXISTS clock_mark'); } finally { await client.end(); }
  } else {
    await rm(url.pathname, { force: true });
  }
}

/**
 * Sixteen inserts in separate statements store created_ts with six fraction
 * digits near the wall clock. A microsecond clock gives at least one value
 * whose last three digits are not 000; a millisecond clock never does.
 */
async function clockMicroseconds(dsn) {
  const db = await Db.connect(dsn);
  try {
    await db.utils().schema().install([clockText]);
    const before = Date.now();
    for (let i = 0; i < 16; i++) {
      const event = new ClockEvent().connect(db);
      event[CORE].setValue('label', `event-${i}`);
      await event.create();
    }
    const after = Date.now();
    const rows = new ClockEvent().connect(db).addAllColumns();
    rows[CORE].orderBy('seq', false, []);
    const stamps = [...(await rows.gets()).values()].map(row => row[CORE].column('created_ts'));
    check(stamps.length === 16, `rows ${stamps.length}`);
    for (const stamp of stamps) {
      check(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(stamp), `created_ts ${stamp} has six fraction digits`);
      const at = Date.parse(`${stamp.replace(' ', 'T').slice(0, 23)}Z`);
      check(at >= before - 1 && at <= after + 1, `created_ts ${stamp} lies between ${new Date(before).toISOString()} and ${new Date(after).toISOString()}`);
    }
    check(stamps.some(stamp => !stamp.endsWith('000')), `every created_ts ends in 000: ${stamps.join(', ')}`);
  } finally { await db.close(); }
}

/** Reads one column of every clock_mark row in seq order with the database driver. */
async function readMarks(dsn, column) {
  const url = new URL(dsn);
  const sql = `SELECT ${column} AS v FROM clock_mark ORDER BY seq`;
  if (url.protocol === 'mysql:') {
    const conn = await require('mysql2/promise').createConnection({ user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1) });
    try { return (await conn.query(sql))[0].map(row => row.v); } finally { await conn.end(); }
  }
  if (url.protocol === 'postgres:') {
    const { Client } = require('pg');
    const client = new Client({ host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1), user: url.username || undefined, password: decodeURIComponent(url.password) || undefined });
    await client.connect();
    try { return (await client.query(sql)).rows.map(row => row.v); } finally { await client.end(); }
  }
  const db = new DatabaseSync(url.pathname);
  try { return db.prepare(sql).all().map(row => row.v); } finally { db.close(); }
}

async function markDb(dsn) {
  const db = await Db.connect(dsn);
  await db.utils().schema().install([markText]);
  return db;
}

/**
 * Sixteen soft deletions in separate statements store deleted_at with six
 * fraction digits. Model reads exclude soft-deleted rows, so the case reads
 * deleted_at with the database driver. At least one value has microseconds
 * that a whole-second clock cannot give.
 */
async function clockSoftDeleteMicroseconds(dsn) {
  const db = await markDb(dsn);
  try {
    for (let i = 0; i < 16; i++) {
      const row = new ClockMark().connect(db);
      row[CORE].setValue('label', `mark-${i}`);
      await (await row.create()).delete();
    }
  } finally { await db.close(); }
  const column = {
    'mysql:': "DATE_FORMAT(deleted_at, '%Y-%m-%d %H:%i:%s.%f')",
    'postgres:': "to_char(deleted_at, 'YYYY-MM-DD HH24:MI:SS.US')",
  }[new URL(dsn).protocol] ?? 'deleted_at';
  const stamps = await readMarks(dsn, column);
  check(stamps.length === 16, `rows ${stamps.length}`);
  for (const stamp of stamps) check(typeof stamp === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(stamp), `deleted_at ${stamp} has six fraction digits`);
  check(stamps.some(stamp => typeof stamp === 'string' && !stamp.endsWith('000')), `every deleted_at ends in 000: ${stamps.join(', ')}`);
}

/**
 * Sixteen rows are read back right after their insert with created_ts <=
 * now() and created_ts <= secondsLater(0). The database clock of the
 * condition is later than the stored creation time, so both match the row.
 */
async function clockNowCondition(dsn) {
  const keys = [
    { conn: '', op: '', column: 'seq', columns: [], compare: '' },
    { conn: 'and', op: 'le', column: 'created_ts', columns: [], compare: '' },
  ];
  const db = await markDb(dsn);
  try {
    for (let i = 0; i < 16; i++) {
      const row = new ClockMark().connect(db);
      row[CORE].setValue('label', `mark-${i}`);
      const seq = (await row.create())[CORE].column('seq');
      for (const [name, fn] of [['now', orm.now()], ['secondsLater(0)', orm.secondsLater(0)]]) {
        const query = new ClockMark().connect(db);
        query[CORE].whereChain('', keys, [seq, fn]);
        const found = await query.getCount();
        check(found === 1, `row ${seq} with created_ts <= ${name}: ${found} rows`);
      }
    }
  } finally { await db.close(); }
}

const cases = {
  clock_microseconds: clockMicroseconds,
  clock_soft_delete_microseconds: clockSoftDeleteMicroseconds,
  clock_now_condition: clockNowCondition,
};
const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(cases);
const targets = { sqlite: `sqlite://${join(work, 'clock.sqlite')}` };
for (const [driver, env] of [['mysql', 'ORM_TEST_MYSQL_DSN'], ['postgres', 'ORM_TEST_POSTGRES_DSN']]) {
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
        await dropTable(driver, dsn);
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${CASE_DEADLINE_MS} ms`)), CASE_DEADLINE_MS); });
        await Promise.race([run(dsn), deadline]);
      } catch (error) {
        failures++;
        console.error(`FAIL ${current}: ${error?.stack ?? error}`);
      } finally {
        clearTimeout(timer);
        await dropTable(driver, dsn);
      }
      console.log(`${failures === before ? 'ok  ' : 'FAIL'} ${current} ${((performance.now() - start) / 1000).toFixed(3)}s`);
    }
    if (failures === caseBefore) console.log(`CASE ${name} PASS`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
if (failures > 0) {
  console.error(`typescript clock test: ${failures} failures`);
  process.exit(1);
}
console.log(`typescript clock test: ${selected.length} cases on ${Object.keys(targets).length} databases passed`);
