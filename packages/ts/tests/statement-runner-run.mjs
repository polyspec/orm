// The statement runner case of INT-150 for one database: statement-runner.mjs and coverage_statement_runner.mjs use this runner.
// It runs db.utils().run(fn) outside a transaction, where it opens one, and inside a transaction, where it joins that one, on the
// database of dsn, and calls check(condition, message) for each expectation that fails.
import { Db } from '../dist/index.js';

/** The first column of the first row of a statement result, as a number. @param {{ rows: unknown[][] }} result */
const firstNumber = result => Number(result.rows[0]?.[0]);

/**
 * Runs SELECT 1 through the runner outside a transaction, where it opens one, and inside a transaction, where it joins it.
 * @param {string} driver
 * @param {string} dsn
 * @param {(condition: boolean, message: string) => void} check
 */
export async function runStatementRunner(driver, dsn, check) {
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
