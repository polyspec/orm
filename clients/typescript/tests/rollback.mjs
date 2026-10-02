// A transaction or savepoint whose callback fails and whose rollback fails
// too, on SQLite, MySQL and PostgreSQL, with the fixture
// contracts/fixtures/rollback.dbspec. The client reports one OrmError with
// the code ROLLBACK and the message `transaction failed (<cause>) and rollback
// failed (<rollback error>)` that keeps the callback error as its cause and
// the rollback error as its rollback. The callback runs only model calls. On
// SQLite a trigger that the test creates raises ROLLBACK when a row labeled
// `end` is inserted, which ends the transaction, so the client's ROLLBACK
// finds no transaction. On MySQL and PostgreSQL a test connection ends the
// server session that holds the transaction, so the next statement and the
// rollback fail. ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name test
// databases; the test fails when either is unset.
//
// Usage: node clients/typescript/tests/rollback.mjs [case ...] (after npm run typescript:build)
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CORE, Db, Model, OrmError, dbspecManifest, parseDbspec, registerModel } from '../dist/index.js';

const require = createRequire(new URL('../package.json', import.meta.url));
const rollbackText = await readFile(new URL('../../../contracts/fixtures/rollback.dbspec', import.meta.url), 'utf8');
const work = await mkdtemp(join(tmpdir(), 'orm-ts-rollback-'));
const CASE_DEADLINE_MS = 30_000;
let failures = 0;
let current = '';
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
const { rollback_probe: RollbackProbe } = models(rollbackText);
const probe = (db, label) => { const m = new RollbackProbe().connect(db); m[CORE].setValue('label', label); return m; };

/** Runs statements on a connection of the test, outside the client, and returns the rows of the last one. */
async function native(driver, dsn, statements) {
  const url = new URL(dsn);
  if (driver === 'mysql') {
    const conn = await require('mysql2/promise').createConnection({ user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1) });
    try { let rows = []; for (const s of statements) [rows] = await conn.query(s); return rows; } finally { await conn.end(); }
  }
  if (driver === 'postgres') {
    const { Client } = require('pg');
    const client = new Client({ host: url.hostname, port: url.port ? Number(url.port) : undefined, database: url.pathname.slice(1), user: url.username || undefined, password: decodeURIComponent(url.password) || undefined });
    await client.connect();
    try { let rows = []; for (const s of statements) ({ rows } = await client.query(s)); return rows; } finally { await client.end(); }
  }
  const db = new DatabaseSync(url.pathname);
  try { for (const s of statements) db.exec(s); return []; } finally { db.close(); }
}

async function dropTable(driver, dsn) {
  if (driver === 'sqlite') await rm(new URL(dsn).pathname, { force: true });
  else await native(driver, dsn, ['DROP TABLE IF EXISTS rollback_probe']);
}

/** Opens the client, installs the fixture and, on SQLite, creates the trigger that raises ROLLBACK. */
async function connect(driver, dsn) {
  const db = await Db.connect(dsn);
  await db.utils().schema().install([rollbackText]);
  if (driver === 'sqlite') {
    await native(driver, dsn, ["CREATE TRIGGER rollback_probe_end BEFORE INSERT ON rollback_probe WHEN NEW.label = 'end' BEGIN SELECT RAISE(ROLLBACK, 'rollback probe ended the transaction'); END"]);
  }
  return db;
}

/** Ends the server session that holds a lock on rollback_probe; SQLite needs none, its trigger ends the transaction. */
async function endSession(driver, dsn) {
  if (driver === 'postgres') {
    const rows = await native(driver, dsn, ["SELECT l.pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'rollback_probe' AND l.pid <> pg_backend_pid() LIMIT 1"]);
    check(rows.length === 1, 'the transaction session holds a lock on rollback_probe');
    await native(driver, dsn, [`SELECT pg_terminate_backend(${Number(rows[0].pid)}, 5000)`]);
  } else if (driver === 'mysql') {
    const rows = await native(driver, dsn, ["SELECT t.PROCESSLIST_ID AS id FROM performance_schema.data_locks l JOIN performance_schema.threads t ON t.THREAD_ID = l.THREAD_ID WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'rollback_probe' LIMIT 1"]);
    check(rows.length === 1, 'the transaction session holds a lock on rollback_probe');
    await native(driver, dsn, [`KILL ${Number(rows[0].id)}`]);
  }
}

/** Checks a ROLLBACK error: both errors are kept and the message names both. */
function checkRollback(error, subject) {
  check(error instanceof OrmError, `${subject} raises ${error}`);
  check(error?.code === 'ROLLBACK', `${subject} code ${error?.code}: ${error?.message}`);
  check(error?.cause !== undefined, `${subject} keeps the callback error`);
  check(error?.rollback !== undefined, `${subject} keeps the rollback error`);
  if (error?.cause !== undefined && error?.rollback !== undefined) {
    const want = `ROLLBACK: transaction failed (${error.cause.message}) and rollback failed (${error.rollback.message})`;
    check(error.message === want, `${subject} message ${JSON.stringify(error.message)}, want ${JSON.stringify(want)}`);
  }
}

/** The callback of a transaction fails and the rollback fails. */
async function rollbackFailed(driver, dsn) {
  const db = await connect(driver, dsn);
  try {
    const error = await raised(() => db.transaction(async () => {
      await probe(db, 'kept').create();
      await endSession(driver, dsn);
      await probe(db, 'end').create();
    }, { retry: 0 }));
    checkRollback(error, 'transaction');
    if (driver === 'sqlite') {
      check(String(error?.cause?.message).includes('rollback probe ended the transaction'), `callback error ${error?.cause?.message}`);
      check(await new RollbackProbe().connect(db).getCount() === 0, 'the trigger rolled the transaction back and the connection serves later requests');
    }
  } finally { await db.close(); }
}

/** The callback of a savepoint fails and the savepoint rollback fails, and then the transaction rollback fails. */
async function savepointRollbackFailed(driver, dsn) {
  const db = await connect(driver, dsn);
  try {
    const error = await raised(() => db.transaction(async () => {
      await probe(db, 'kept').create();
      await db.transaction(async () => {
        await probe(db, 'nested').create();
        await endSession(driver, dsn);
        await probe(db, 'end').create();
      });
    }, { retry: 0 }));
    checkRollback(error, 'transaction');
    checkRollback(error?.cause, 'savepoint');
    if (driver === 'sqlite') check(await new RollbackProbe().connect(db).getCount() === 0, 'the trigger rolled the transaction back and the connection serves later requests');
  } finally { await db.close(); }
}

const cases = { rollback_failed: rollbackFailed, savepoint_rollback_failed: savepointRollbackFailed };
const selected = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(cases);
const targets = { sqlite: `sqlite://${join(work, 'rollback.sqlite')}` };
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
        await Promise.race([run(driver, dsn), deadline]);
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
  console.error(`typescript rollback test: ${failures} failures`);
  process.exit(1);
}
console.log(`typescript rollback test: ${selected.length} cases on ${Object.keys(targets).length} databases passed`);
