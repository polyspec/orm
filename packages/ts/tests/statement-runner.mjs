// The statement runner of INT-150 on every database: db.utils().run(fn) calls fn with a transaction frame of the
// connection, and frame.run(kind, tables, sql, params) runs one statement and returns its result with its rows.
// Outside a transaction, utils().run opens one and ends it without retry; inside a transaction, it joins that one.
// The declaration surface (utils().run is public API in dist/*.d.ts) is checked by the parity api unit of T345-7; this file
// checks the behavior on each database.
// Each case runs in its own case database (case-database.mjs) and fails when ORM_TEST_MYSQL_DSN or
// ORM_TEST_POSTGRES_DSN is missing.
//
// Usage: node packages/ts/tests/statement-runner.mjs [case ...] (after npm run typescript:build)
import { withCaseDatabase } from './case-database.mjs';
import { registerDatabaseCases } from './database-case-tests.mjs';
import { createFailureCheck } from './check-state.mjs';
import { runStatementRunner, runStatementRunnerRefusals } from './statement-runner-run.mjs';

// CASE_DEADLINE_MS is the deadline of one case: it connects, runs a statement outside and inside a transaction, and disconnects.
const CASE_DEADLINE_MS = 60_000;
let failures = 0;
let current = '';
const check = createFailureCheck(() => current, () => { failures++; });

/**
 * Runs the statement runner case of runStatementRunner on the database of dsn.
 * @param {string} driver
 * @param {string} dsn
 */
async function statementRunner(driver, dsn) {
  await runStatementRunner(driver, dsn, check);
}

/**
 * Runs the refusals of runStatementRunnerRefusals on the database of dsn.
 * @param {string} driver
 * @param {string} dsn
 */
async function statementRunnerRefusals(driver, dsn) {
  await runStatementRunnerRefusals(driver, dsn, check);
}

// Requirements: INT-150, INT-150a, INT-150b.
const cases = {
  statement_runner: statementRunner,
  statement_runner_refusals: statementRunnerRefusals,
};
registerDatabaseCases({
  feature: 'statement-runner', cases, deadline: CASE_DEADLINE_MS, withDatabase: withCaseDatabase,
  getFailures: () => failures,
  setCurrent: /** @type {(value: string) => void} */ (value => { current = value; }),
  runCase: /** @type {(run: (driver: string, dsn: string) => Promise<void>, _name: string, driver: string, database: { dsn: string }) => Promise<void>} */ ((run, _name, driver, database) => run(driver, database.dsn)),
});
if (failures > 0) process.exitCode = 1;
