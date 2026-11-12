// The refusals of INT-150a and INT-150b on every database; the recipe statement_runner holds the rest of INT-150.
//
// Usage: node packages/ts/tests/statement-runner.mjs [case ...] (after npm run typescript:build)
import { withCaseDatabase } from './case-database.mjs';
import { registerDatabaseCases } from './database-case-tests.mjs';
import { createFailureCheck } from './check-state.mjs';
import { runStatementRunnerRefusals } from './statement-runner-run.mjs';

// CASE_DEADLINE_MS is the deadline of one case: it connects, runs a statement outside and inside a transaction, and disconnects.
const CASE_DEADLINE_MS = 60_000;
let failures = 0;
let current = '';
const check = createFailureCheck(() => current, () => { failures++; });

/**
 * Runs the refusals of runStatementRunnerRefusals on the database of dsn.
 * @param {string} driver
 * @param {string} dsn
 */
async function statementRunnerRefusals(driver, dsn) {
  await runStatementRunnerRefusals(driver, dsn, check);
}

// Requirements: INT-150a, INT-150b.
const cases = {
  statement_runner_refusals: statementRunnerRefusals,
};
registerDatabaseCases({
  feature: 'statement-runner', cases, deadline: CASE_DEADLINE_MS, withDatabase: withCaseDatabase,
  getFailures: () => failures,
  setCurrent: /** @type {(value: string) => void} */ (value => { current = value; }),
  runCase: /** @type {(run: (driver: string, dsn: string) => Promise<void>, _name: string, driver: string, database: { dsn: string }) => Promise<void>} */ ((run, _name, driver, database) => run(driver, database.dsn)),
});
if (failures > 0) process.exitCode = 1;
