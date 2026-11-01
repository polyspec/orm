// The statement runner of INT-150 on every database: db.utils().run(fn) calls fn with a transaction frame of the
// connection, and frame.run(kind, tables, sql, params) runs one statement and returns its result with its rows.
// Outside a transaction, utils().run opens one and ends it without retry; inside a transaction, it joins that one.
// The declaration surface (utils().run is public API in dist/*.d.ts) is checked by the parity api unit of T345-7; this file
// checks the behavior on each database.
// Each case runs in its own case database (case-database.mjs) and fails when ORM_TEST_MYSQL_DSN or
// ORM_TEST_POSTGRES_DSN is missing.
//
// Usage: node packages/ts/tests/statement-runner.mjs [case ...] (after npm run typescript:build)
import { Db } from '../dist/index.js';
import { withCaseDatabase } from './case-database.mjs';
import { registerDatabaseCases } from './database-case-tests.mjs';
import { createFailureCheck } from './check-state.mjs';

// CASE_DEADLINE_MS is the deadline of one case: it connects, runs a statement outside and inside a transaction, and disconnects.
const CASE_DEADLINE_MS = 60_000;
let failures = 0;
let current = '';
const check = createFailureCheck(() => current, () => { failures++; });

/** The first column of the first row of a statement result, as a number. @param {{ rows: unknown[][] }} result */
const firstNumber = result => Number(result.rows[0]?.[0]);

/**
 * Runs SELECT 1 through the runner outside a transaction, where it opens one, and inside a transaction, where it joins it.
 * @param {string} driver
 * @param {string} dsn
 */
async function statementRunner(driver, dsn) {
  const db = await Db.connect(dsn);
  try {
    const outside = await db.utils().run(async frame => frame.run('utility', [], 'SELECT 1'));
    check(firstNumber(outside) === 1, `${driver}: utils().run outside a transaction did not return 1 as its first column`);

    /** @type {{ rows: unknown[][] } | null} */
    let inside = null;
    await db.transaction(async () => {
      inside = await db.utils().run(async frame => frame.run('utility', [], 'SELECT 1'));
    }, { retry: 0 });
    const got = /** @type {{ rows: unknown[][] } | null} */ (inside);
    check(got !== null && firstNumber(got) === 1, `${driver}: utils().run inside a transaction did not return 1 as its first column`);
  } finally {
    await db.close();
  }
}

// Requirements: INT-150.
const cases = {
  statement_runner: statementRunner,
};
registerDatabaseCases({
  feature: 'statement-runner', cases, deadline: CASE_DEADLINE_MS, withDatabase: withCaseDatabase,
  getFailures: () => failures,
  setCurrent: /** @type {(value: string) => void} */ (value => { current = value; }),
  runCase: /** @type {(run: (driver: string, dsn: string) => Promise<void>, _name: string, driver: string, database: { dsn: string }) => Promise<void>} */ ((run, _name, driver, database) => run(driver, database.dsn)),
});
if (failures > 0) process.exitCode = 1;
