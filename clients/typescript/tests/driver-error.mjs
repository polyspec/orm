// Driver errors that the error catalog does not list, and CHECK violations,
// on SQLite, MySQL and PostgreSQL, with the fixture
// contracts/fixtures/refusal.dbs. refused_row is immutable, so its triggers
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
import { CORE, Db, Model, OrmError, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';
import { runCase } from '../../../tests/testcase.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const refusalText = await readFile(new URL('../../../contracts/fixtures/refusal.dbs', import.meta.url), 'utf8');
const work = await mkdtemp(join(tmpdir(), 'orm-ts-driver-error-'));
// CASE_DEADLINE_MS는 case 하나의 기한이다. case 하나는 table을 지우고 refusal 문서를 설치해 거부되는 쓰기 몇 개를 실행한 뒤 지운다.
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
async function raised(run) {
  try { await run(); return undefined; } catch (error) { return error; }
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
const { refused_row: RefusedRow } = models(refusalText);
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
      await client.query('SET client_min_messages = warning');
      await client.query('DROP TABLE IF EXISTS refused_row');
      for (const f of ['refused_row$immutable_update', 'refused_row$immutable_delete']) await client.query(`DROP FUNCTION IF EXISTS "${f}"()`);
    } finally { await client.end(); }
  } else {
    await rm(url.pathname, { force: true });
  }
}

async function connect(dsn) {
  const db = await Db.connect(dsn);
  await db.utils().schema().install(schemaOf(refusalText));
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
    check(String(error?.message).includes('table refused_row is immutable'), `refused update message ${error?.message}`);
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
    for (const [driver, dsn] of Object.entries(targets)) {
      const before = failures;
      current = `${name}/${driver}`;
      const passed = await runCase(`driver-error/${current}`, CASE_DEADLINE_MS, async () => {
        try {
          await dropTable(driver, dsn);
          await run(dsn);
        } finally {
          await dropTable(driver, dsn);
        }
        if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
      });
      if (!passed && failures === before) failures++;
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
if (failures > 0) process.exitCode = 1;
