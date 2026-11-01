// statement_runner coverage: on the database that feature-check chose (ORM_FEATURE_DATABASE), the statement runner runs on a
// new case database (case-database.mjs), outside and inside a transaction, as statement-runner.mjs does. The bench database
// is not read or written. The output is only the lines of the passing cases.
// Requirements: INT-150.
import { DATABASE } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { runCases } from './coverage_case.mjs';
import { runStatementRunner } from './statement-runner-run.mjs';

await runCases('coverage_statement_runner.mjs', {
  // Requirements: INT-150.
  async statement_runner({ driver }) {
    const failures = [];
    const check = (condition, message) => { if (!condition) failures.push(message); };
    await withCaseDatabase(driver, () => {}, database => runStatementRunner(driver, database.dsn, check));
    if (failures.length > 0) throw new Error(failures.join('\n'));
  },
}, DATABASE);
