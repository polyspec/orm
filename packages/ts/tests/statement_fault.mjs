// The refusal of an empty argument of the test entry point's statement fault, on SQLite, MySQL and PostgreSQL, with
// the fixture contracts/fixtures/statement_fault.json (protocol section 3.2): failNextStatement(db, code, message) of
// @polyspec/orm/testing refuses an empty code or message with a TypeError, the programmer-error signal of the client, and
// arms nothing. The refused statement, its event and its consumption are the cases a_statement_fault_* of the recipe
// transactions. The case of the fixture runs on each of the three databases; a fixture case that did not pass on every
// database fails its test. Each case runs on a case database of its
// own (case-database.mjs); the test fails when ORM_TEST_MYSQL_DSN or
// ORM_TEST_POSTGRES_DSN is unset.
//
// The entry point's own check (the fault is exported under orm-test only) is in statement_fault_entry.mjs.
//
// Usage: node --conditions=orm-test packages/ts/tests/statement_fault.mjs (after npm run typescript:build)
import { readFile } from 'node:fs/promises';
import { caseTest } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { Db, CORE } from '../dist/index.js';
import * as testing from '@polyspec/orm/testing';
import { models } from './registered_models.mjs';
import { schemaOf } from './schema_of.mjs';
import { captureError } from './capture-error.mjs';

const fixture = JSON.parse(await readFile(new URL('../../../contracts/fixtures/statement_fault.json', import.meta.url), 'utf8'));
const rollbackText = await readFile(new URL('../../../contracts/fixtures/rollback.dbs', import.meta.url), 'utf8');
const { code, message } = fixture;
if (fixture.schema !== 1 || typeof code !== 'string' || code === '' || typeof message !== 'string' || message === '' || !Array.isArray(fixture.cases)) {
  throw new Error('contracts/fixtures/statement_fault.json is not a schema 1 fixture with a code, a message and cases');
}

// A case's deadline. A case builds a case database, installs the fixture and runs a few statements.
const CASE_DEADLINE_MS = 30_000;
const DRIVERS = ['sqlite', 'mysql', 'postgres'];
for (const env of ['ORM_TEST_MYSQL_DSN', 'ORM_TEST_POSTGRES_DSN']) {
  if (!process.env[env]) throw new Error(`${env} is required; run make orm-test-servers, which starts the databases and writes it; run the test through its make target, which reads the environment of make orm-test-servers`);
}

let failures = 0;
let current = '';

function check(cond, message) {
  if (!cond) { failures++; console.error(`FAIL ${current}: ${message}`); }
}
const raised = run => captureError(run, { success: undefined });
function raisedSync(run) {
  try { run(); return undefined; } catch (error) { return error; }
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

/** Returns failNextStatement of the test entry point, or fails the case when the entry point does not export it. */
function requireFaultEntry() {
  if (typeof testing.failNextStatement !== 'function') {
    throw new Error('@polyspec/orm/testing does not export failNextStatement (the test entry point under the condition orm-test)');
  }
  return testing.failNextStatement;
}

const cases = {
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
