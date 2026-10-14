// The test entry point's statement fault, on SQLite, MySQL and PostgreSQL, with
// the fixture contracts/fixtures/statement_fault.json (protocol section 3.2).
// Each case arms failNextStatement(db, code, message) from @polyspec/orm/testing
// and checks the refused statement: the ORM error with the given code and
// message, the statement event that carries the error, and a database that
// the refused statement did not change. The four cases of the fixture run on
// each of the three databases; a fixture case that did not pass on every
// database fails its test. Each case runs on a case database of its
// own (case-database.mjs); the test fails when ORM_TEST_MYSQL_DSN or
// ORM_TEST_POSTGRES_DSN is unset.
//
// Usage: node --conditions=orm-test packages/ts/tests/statement_fault.mjs (after npm run typescript:build)
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { caseTest, runCase } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { Db, Model, OrmError, dbspecManifest, parseDbspec, registerModel, CORE } from '../dist/index.js';
import * as packageEntry from '../dist/index.js';
import * as testing from '@polyspec/orm/testing';

const fixture = JSON.parse(await readFile(new URL('../../../contracts/fixtures/statement_fault.json', import.meta.url), 'utf8'));
const rollbackText = await readFile(new URL('../../../contracts/fixtures/rollback.dbs', import.meta.url), 'utf8');
const { code, message } = fixture;
const faultText = `${code}: ${message}`;
if (fixture.schema !== 1 || typeof code !== 'string' || code === '' || typeof message !== 'string' || message === '' || !Array.isArray(fixture.cases)) {
  throw new Error('contracts/fixtures/statement_fault.json is not a schema 1 fixture with a code, a message and cases');
}

// A case's deadline. A case builds a case database, installs the fixture and runs a few statements.
const CASE_DEADLINE_MS = 30_000;
const DRIVERS = ['sqlite', 'mysql', 'postgres'];
for (const env of ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_POSTGRES_DSN']) {
  if (!process.env[env]) throw new Error(`${env} is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers`);
}

let failures = 0;
let current = '';

function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}
async function raised(run) {
  try { await run(); return undefined; } catch (error) { return error; }
}
function raisedSync(run) {
  try { run(); return undefined; } catch (error) { return error; }
}

/** A document text's generated schema value: its manifest text and manifestHash. */
function schemaOf(text) {
  const { manifest } = dbspecManifest([parseDbspec(text, {}).document]);
  return { manifestText: manifest.manifestText, manifestHash: manifest.manifestHash };
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
const countOf = db => new RollbackProbe().connect(db).getCount();

/** Opens the client and installs the fixture document set on the connection. */
async function connect(dsn) {
  const db = await Db.connect(dsn);
  await db.utils().schema().install(schemaOf(rollbackText));
  return db;
}

/**
 * Checks that an error is the ORM error of the armed fault: its code and its message. OrmError
 * takes the message as its text and prefixes the code (`CODE: text`, runtime_error.ts).
 */
function checkFaultError(error, subject) {
  check(error instanceof OrmError, `${subject} raises an OrmError: ${error}`);
  check(error?.code === code, `${subject} code ${error?.code}, want ${code}`);
  check(error?.message === faultText, `${subject} message ${JSON.stringify(error?.message)}, want ${JSON.stringify(faultText)}`);
}

/** The insert is refused: the error, the statement event and the unchanged database. */
async function refusedInsert(driver, dsn) {
  const fail = requireFaultEntry();
  const db = await connect(dsn);
  try {
    const events = [];
    const unsubscribe = db.subscribe(event => events.push(event));
    fail(db, code, message);
    const error = await raised(() => probe(db, 'refused').create());
    checkFaultError(error, 'the refused insert');
    const failed = events.filter(event => event.error !== null);
    check(failed.length === 1, `one statement event carries the error: ${failed.length}`);
    check(failed[0]?.error?.code === code && failed[0]?.error?.message === faultText, `the statement event carries the error ${failed[0]?.error?.code} ${failed[0]?.error?.message}`);
    unsubscribe();
    check(await countOf(db) === 0, 'the refused insert leaves the table unchanged');
  } finally { await db.close(); }
}

/** The fault is consumed by one statement: the next statement of the connection runs. */
async function consumedByOneStatement(driver, dsn) {
  const fail = requireFaultEntry();
  const db = await connect(dsn);
  try {
    fail(db, code, message);
    checkFaultError(await raised(() => probe(db, 'first').create()), 'the refused insert');
    const second = await raised(() => probe(db, 'second').create());
    check(second === undefined, `the statement after the consumed fault raises ${second}`);
    check(await countOf(db) === 1, 'only the second insert is stored');
  } finally { await db.close(); }
}

/** BEGIN is not consumed: the insert inside the transaction is refused and the transaction rolls back. */
async function refusedInTransaction(driver, dsn) {
  const fail = requireFaultEntry();
  const db = await connect(dsn);
  try {
    fail(db, code, message);
    const error = await raised(() => db.transaction(async () => { await probe(db, 'in transaction').create(); }, { retry: 0 }));
    checkFaultError(error, 'the transaction');
    check(await countOf(db) === 0, 'the refused insert and the rollback leave the table unchanged');
    const after = await raised(() => probe(db, 'after').create());
    check(after === undefined, `the insert after the consumed fault raises ${after}`);
    check(await countOf(db) === 1, 'the insert after the transaction is stored');
  } finally { await db.close(); }
}

/** An empty code or message is refused with a TypeError (the programmer-error signal of the client) and arms nothing. */
async function emptyArgumentRefused(driver, dsn) {
  const fail = requireFaultEntry();
  const db = await connect(dsn);
  try {
    for (const [argCode, argMessage, label] of [['', message, 'empty code'], [code, '', 'empty message']]) {
      const error = raisedSync(() => fail(db, argCode, argMessage));
      check(error instanceof TypeError, `${label} is refused with a TypeError: ${error}`);
    }
    const after = await raised(() => probe(db, 'after refusal').create());
    check(after === undefined, `the insert after the refused arguments raises ${after}`);
    check(await countOf(db) === 1, 'the refused arguments armed nothing: the insert is stored');
  } finally { await db.close(); }
}

/** The test entry point exports the fault under orm-test only, and the package entry point exports none. */
function checkFaultEntry() {
  const packageRoot = new URL('..', import.meta.url).pathname;
  const load = "await import('@polyspec/orm/testing')";
  const plain = spawnSync(process.execPath, ['--input-type=module', '-e', load], { cwd: packageRoot, encoding: 'utf8' });
  check(plain.status !== 0 && plain.stderr.includes('ERR_PACKAGE_PATH_NOT_EXPORTED'), `the test entry point resolves without the condition orm-test: status ${plain.status} ${plain.stderr}`);
  check(typeof testing.failNextStatement === 'function', '@polyspec/orm/testing does not export failNextStatement');
  check(!('failNextStatement' in packageEntry), 'the package entry point exports failNextStatement');
}

/** Returns failNextStatement of the test entry point, or fails the case when the entry point does not export it. */
function requireFaultEntry() {
  if (typeof testing.failNextStatement !== 'function') {
    throw new Error('@polyspec/orm/testing does not export failNextStatement (the test entry point under the condition orm-test)');
  }
  return testing.failNextStatement;
}

const cases = {
  refused_insert: refusedInsert,
  consumed_by_one_statement: consumedByOneStatement,
  refused_in_transaction: refusedInTransaction,
  empty_argument_refused: emptyArgumentRefused,
};

// The guard: every case of the fixture has a function here, and each one passed on every database.
const fixtureCases = new Set(fixture.cases);
for (const name of Object.keys(cases)) {
  if (!fixtureCases.has(name)) { failures++; console.error(`FAIL guard: case ${name} is not named by the fixture`); }
}
for (const name of fixture.cases) {
  if (cases[name] === undefined) { failures++; console.error(`FAIL guard: fixture case ${name} has no test`); }
}

{
  current = 'entry_point';
  const before = failures;
  const ok = await runCase('statement-fault-entry/entry_point', CASE_DEADLINE_MS, async ({ step }) => {
    step('spawn the entry point checks');
    checkFaultEntry();
    if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
  });
  if (!ok && failures === before) failures++;
}

if (failures > 0) process.exitCode = 1;

// One test per fixture case, named by the case: the case passes when it passes on SQLite, MySQL and PostgreSQL.
for (const name of fixture.cases) {
  const run = cases[name];
  if (run === undefined) continue;
  caseTest(name, CASE_DEADLINE_MS * DRIVERS.length, async ({ step }) => {
    const before = failures;
    current = name;
    for (const driver of DRIVERS) {
      await withCaseDatabase(driver, step, database => run(driver, database.dsn));
    }
    if (failures > before) throw new Error(`${failures - before} check(s) failed; each FAIL line above names one`);
  });
}
