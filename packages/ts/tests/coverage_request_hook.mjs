// request_hook coverage: each case of request_hook_run.mjs runs on the database that feature-check chose (ORM_FEATURE_DATABASE)
// in a new case database (case-database.mjs). It does not read or write the database of ORM_FEATURE_DSN. The output is
// only the lines of the passing cases.
import { DATABASE } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { runCases } from './coverage_case.mjs';
import { cases, runOn } from './request_hook_run.mjs';

const coverage = {};
for (const [name, run] of Object.entries(cases)) {
  coverage[name] = async ({ driver }) => {
    await withCaseDatabase(driver, () => {}, database => runOn(database.dsn, () => {}, run));
  };
}
await runCases('coverage_request_hook.mjs', coverage, DATABASE);
