// The clock of datetime(6) columns, on SQLite, MySQL and PostgreSQL, with the
// fixtures contracts/fixtures/clock.dbs and clock_mark.dbs. An insert
// that omits created_ts (default now) takes the database clock on MySQL and
// PostgreSQL and binds the client clock of the `now` slot on SQLite, whose
// database clock has milliseconds only; either way the stored fraction holds
// microseconds. A clock with millisecond resolution stores every value as
// `.mmm000`. Each case runs on a case database of its own on the servers of
// ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, or a new SQLite file
// (case-database.mjs); the test fails when either DSN is unset.
//
// Usage: node packages/orm-npm/tests/clock.mjs [case ...] (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { CORE, Db, Model, dbspecManifest, orm, parseDbspec, registerModel } from '../dist/index.js';
import { wallMicros } from '../dist/clock.js';
import { runCase } from '../../../tests/testcase.mjs';
import { mysqlConnection, postgresClient, withCaseDatabase } from './case-database.mjs';

const clockText = await readFile(new URL('../../../contracts/fixtures/clock.dbs', import.meta.url), 'utf8');
const markText = await readFile(new URL('../../../contracts/fixtures/clock_mark.dbs', import.meta.url), 'utf8');
// CASE_DEADLINE_MS는 case 하나의 기한이다. case 하나는 case database를 만들고 clock_mark 문서를 설치해 row 몇 개를 쓰고 읽은 뒤 database를 지운다.
const CASE_DEADLINE_MS = 30_000;
let failures = 0;
let current = '';
/** A document text's generated schema value: its manifest text and manifestHash. */
function schemaOf(text) {
  const { manifest } = dbspecManifest([parseDbspec(text, {}).document]);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
}

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

/**
 * Sixteen inserts in separate statements store created_ts with six fraction
 * digits near the wall clock. A microsecond clock gives at least one value
 * whose last three digits are not 000; a millisecond clock never does.
 */
async function clockMicroseconds(dsn) {
  const db = await Db.connect(dsn);
  try {
    await db.utils().schema().install(schemaOf(clockText));
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
    const conn = await mysqlConnection(dsn);
    try { return (await conn.query(sql))[0].map(row => row.v); } finally { await conn.end(); }
  }
  if (url.protocol === 'postgres:') {
    const client = postgresClient(dsn);
    await client.connect();
    try { return (await client.query(sql)).rows.map(row => row.v); } finally { await client.end(); }
  }
  const db = new DatabaseSync(url.pathname);
  try { return db.prepare(sql).all().map(row => row.v); } finally { db.close(); }
}

async function markDb(dsn) {
  const db = await Db.connect(dsn);
  await db.utils().schema().install(schemaOf(markText));
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

/**
 * wallMicros under a wall clock and a monotonic clock that the case sets.
 * The monotonic clock runs ahead of the wall clock, which never goes back:
 * reading a falls 1.9 ms after the millisecond of the wall clock, reading b
 * 2.0 ms after the millisecond of reading a, and Date.now() advances by one
 * millisecond between them. Every reading lies within the millisecond that
 * Date.now() reports, and reading b is not earlier than reading a; a now
 * condition read right after an insert then matches the inserted row.
 */
function clockWallMicrosOrder() {
  const wallNow = Date.now;
  const monotonicNow = performance.now;
  let wall = 0;
  let monotonic = 0;
  Date.now = () => wall;
  performance.now = () => monotonic;
  try {
    // base는 실제 wall clock보다 하루 뒤라서, 첫 읽기는 그 millisecond의 시작으로 옮겨지고 anchor가 정해진다.
    const base = wallNow() + 86_400_000;
    wall = base; monotonic = 1_000;
    const start = wallMicros();
    check(start === base * 1000, `start ${start} is the wall clock ${base * 1000}`);
    const readings = [];
    for (const [w, m] of [[base + 4000, 5001.9], [base + 4001, 5003.0], [base + 4001, 5003.5], [base + 4002, 5004.2]]) {
      wall = w; monotonic = m;
      const micros = wallMicros();
      readings.push(micros);
      check(Math.floor(micros / 1000) === w, `reading ${micros} at wall ${w} and monotonic ${m} lies within the millisecond of the wall clock`);
    }
    for (let i = 1; i < readings.length; i++) {
      check(readings[i] >= readings[i - 1], `reading ${readings[i]} is not earlier than the previous reading ${readings[i - 1]} while the wall clock goes from ${base + 4000} to ${base + 4002}`);
    }
  } finally {
    Date.now = wallNow;
    performance.now = monotonicNow;
  }
}

// databaseFree는 database 없이 한 번 실행하는 case다.
const databaseFree = {
  clock_wall_micros_order: clockWallMicrosOrder,
};
const cases = {
  clock_microseconds: clockMicroseconds,
  clock_soft_delete_microseconds: clockSoftDeleteMicroseconds,
  clock_now_condition: clockNowCondition,
};
const selected = process.argv.length > 2 ? process.argv.slice(2) : [...Object.keys(databaseFree), ...Object.keys(cases)];
for (const name of selected.filter(name => Object.hasOwn(databaseFree, name))) {
  const before = failures;
  current = name;
  const passed = await runCase(`clock/${name}`, CASE_DEADLINE_MS, async () => {
    databaseFree[name]();
    if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
  });
  if (!passed && failures === before) failures++;
}
const databaseCases = selected.filter(name => !Object.hasOwn(databaseFree, name));
for (const env of databaseCases.length > 0 ? ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_POSTGRES_DSN'] : []) {
  if (!process.env[env]) throw new Error(`${env} is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers`);
}
for (const name of databaseCases) {
  const run = cases[name];
  if (run === undefined) throw new Error(`unknown case ${name}`);
  for (const driver of ['sqlite', 'mysql', 'postgres']) {
    const before = failures;
    current = `${name}/${driver}`;
    const passed = await runCase(`clock/${current}`, CASE_DEADLINE_MS, async ({ step }) => {
      await withCaseDatabase(driver, step, database => run(database.dsn));
      if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
    });
    if (!passed && failures === before) failures++;
  }
}
if (failures > 0) process.exitCode = 1;
