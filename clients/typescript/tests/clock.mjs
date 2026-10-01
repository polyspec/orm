// The client clock of the `now` bind slot, on SQLite, MySQL and PostgreSQL.
// Each insert of clock_event fills created_ts from the client clock, so its
// stored fraction holds the microseconds of the wall clock. A clock with
// millisecond resolution stores every value as `.mmm000`. ORM_TEST_MYSQL_DSN
// and ORM_TEST_POSTGRES_DSN name test databases; the test fails when either
// is unset.
//
// Usage: node clients/typescript/tests/clock.mjs [case ...] (after npm run typescript:build)
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE, Db, Model, registerSchema } from '../dist/index.js';

const require = createRequire(new URL('../package.json', import.meta.url));
const schemaPath = new URL('../../../contracts/fixtures/clock_schema.json', import.meta.url).pathname;
const schemaJson = await readFile(schemaPath, 'utf8');
const manifest = JSON.parse(schemaJson);
const work = await mkdtemp(join(tmpdir(), 'orm-ts-clock-'));
const CASE_DEADLINE_MS = 30_000;
let failures = 0;
let current = '';
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}

const entities = new Map(Object.values(manifest.entities).map(e => [e.name, {
  name: e.name, table: e.table, pk: e.pk, auto: e.auto, fulltext: [],
  columns: Object.fromEntries(e.columns.map(c => [c.name, { type: c.type, nullable: c.nullable ?? false, styles: c.styles }])),
}]));
const set = { hash: manifest.schema_hash, entities };
registerSchema(set);
class ClockEvent extends Model {}
ClockEvent.entity = { schema: entities.get('clock_event'), set, create: core => new ClockEvent(core) };

/** Drops the test table with the database driver; SQLite uses a new file per run. */
async function dropTable(driver, dsn) {
  const url = new URL(dsn);
  if (driver === 'mysql') {
    const conn = await require('mysql2/promise').createConnection({ user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1) });
    try { await conn.query('DROP TABLE IF EXISTS clock_event'); } finally { await conn.end(); }
  } else if (driver === 'postgres') {
    const { Client } = require('pg');
    const client = new Client({ host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1), user: url.username || undefined, password: decodeURIComponent(url.password) || undefined });
    await client.connect();
    try { await client.query('DROP TABLE IF EXISTS clock_event'); } finally { await client.end(); }
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
  const db = await Db.connect(`${dsn}${dsn.includes('?') ? '&' : '?'}timezone=%2B00:00`, schemaPath);
  try {
    await db.utils().schema().install(schemaJson);
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

const cases = { clock_microseconds: clockMicroseconds };
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
