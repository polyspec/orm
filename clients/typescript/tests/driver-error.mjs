// Driver errors that the error catalog does not list, and CHECK violations,
// on SQLite, MySQL and PostgreSQL. refused_row is immutable, so its triggers
// refuse every update with a database error that the catalog does not list;
// the client reports it as an OrmError with the code DRIVER, the driver
// message, and the driver error as its cause. Its CHECK constraint refuses a
// nonpositive amount with CONSTRAINT. ORM_TEST_MYSQL_DSN and
// ORM_TEST_POSTGRES_DSN name test databases; the test fails when either is
// unset.
//
// Usage: node clients/typescript/tests/driver-error.mjs [case ...] (after npm run typescript:build)
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE, Db, Model, OrmError, registerSchema } from '../dist/index.js';

const require = createRequire(new URL('../package.json', import.meta.url));
const schemaPath = new URL('../../../contracts/fixtures/refusal_schema.json', import.meta.url).pathname;
const schemaJson = await readFile(schemaPath, 'utf8');
const manifest = JSON.parse(schemaJson);
const work = await mkdtemp(join(tmpdir(), 'orm-ts-driver-error-'));
const CASE_DEADLINE_MS = 30_000;
let failures = 0;
let current = '';
function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}
async function raised(run) {
  try { await run(); return undefined; } catch (error) { return error; }
}

const entities = new Map(Object.values(manifest.entities).map(e => [e.name, {
  name: e.name, table: e.table, pk: e.pk, auto: e.auto, fulltext: [],
  columns: Object.fromEntries(e.columns.map(c => [c.name, { type: c.type, nullable: c.nullable ?? false, styles: c.styles }])),
}]));
const set = { hash: manifest.schema_hash, entities };
registerSchema(set);
class RefusedRow extends Model {}
RefusedRow.entity = { schema: entities.get('refused_row'), set, create: core => new RefusedRow(core) };
const row = (db, amount) => { const m = new RefusedRow().connect(db); m[CORE].setValue('amount', amount); return m; };

/** Drops the test table with the database driver; SQLite uses a new file per run. */
async function dropTable(driver, dsn) {
  const url = new URL(dsn);
  if (driver === 'mysql') {
    const conn = await require('mysql2/promise').createConnection({ user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1) });
    try { await conn.query('DROP TABLE IF EXISTS refused_row'); } finally { await conn.end(); }
  } else if (driver === 'postgres') {
    const { Client } = require('pg');
    const client = new Client({ host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1), user: url.username || undefined, password: decodeURIComponent(url.password) || undefined });
    await client.connect();
    try {
      await client.query('DROP TABLE IF EXISTS refused_row');
      await client.query('DROP FUNCTION IF EXISTS refused_row_immutable_reject()');
    } finally { await client.end(); }
  } else {
    await rm(url.pathname, { force: true });
  }
}

async function connect(dsn) {
  const db = await Db.connect(dsn, schemaPath);
  await db.utils().schema().install(schemaJson);
  return db;
}

/** An update that the immutable trigger refuses fails with DRIVER and keeps the driver error. */
async function triggerRefused(dsn) {
  const db = await connect(dsn);
  try {
    const created = await row(db, 1).create();
    const seq = created[CORE].column('seq');
    const error = await raised(() => { created[CORE].setValue('amount', 2); return created.update(); });
    check(error instanceof OrmError, `refused update raises ${error}`);
    check(error?.code === 'DRIVER', `refused update code ${error?.code}`);
    check(String(error?.message).includes('immutable table: refused_row'), `refused update message ${error?.message}`);
    check(error?.cause !== undefined && !(error.cause instanceof OrmError), 'refused update keeps the driver error');
    const stored = await new RefusedRow().connect(db).seq(seq).addAllColumns().get();
    check(stored?.[CORE].column('amount') === 1, 'refused update keeps the row');
  } finally { await db.close(); }
}

/** An insert that the CHECK constraint refuses fails with CONSTRAINT. */
async function checkRefused(dsn) {
  const db = await connect(dsn);
  try {
    const error = await raised(() => row(db, 0).create());
    check(error instanceof OrmError, `refused insert raises ${error}`);
    check(error?.code === 'CONSTRAINT', `refused insert code ${error?.code}`);
    check(String(error?.message).includes('amount_positive'), `refused insert message ${error?.message}`);
    check(error?.cause !== undefined && !(error.cause instanceof OrmError), 'refused insert keeps the driver error');
    check(await new RefusedRow().connect(db).getCount() === 0, 'refused insert writes no row');
  } finally { await db.close(); }
}

const cases = { trigger_refused: triggerRefused, check_refused: checkRefused };
const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(cases);
const targets = { sqlite: `sqlite://${join(work, 'driver-error.sqlite')}` };
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
  console.error(`typescript driver error test: ${failures} failures`);
  process.exit(1);
}
console.log(`typescript driver error test: ${selected.length} cases on ${Object.keys(targets).length} databases passed`);
