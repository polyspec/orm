// request_hook coverage: each case of request_hook_run.mjs runs on the database that feature-check chose (ORM_FEATURE_DATABASE)
// in a new case database (case-database.mjs). It does not read or write the database of ORM_FEATURE_DSN. The output is
// only the lines of the passing cases.
import { DATABASE } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { runCases } from './coverage_case.mjs';
import { cases, runOn } from './request_hook_run.mjs';

// Requirements, by case of request_hook_run.mjs (each case runs in every database item of this file; the cases that the
// recipe request_hook does not run, FCV-4):
// without_hook: Requirements: INT-78.
// read_filter: Requirements: INT-78, PRT-2.
// relation_scope: Requirements: INT-78.
// invalid_param: Requirements: PRT-65.
// restore_no_key: Requirements: DIA-161.
// restore_rewritten_key: Requirements: DIA-161.
// restore_hook_set_key: Requirements: DIA-161.
// restore_rewritten_key_set_scope: Requirements: DIA-161.
// reads_params: Requirements: INT-78.
const coverage = {};
for (const name of [
  'without_hook', 'read_filter', 'relation_scope', 'invalid_param', 'restore_no_key', 'restore_rewritten_key', 'restore_hook_set_key',
  'restore_rewritten_key_set_scope', 'reads_params',
]) {
  const run = cases[name];
  coverage[name] = async ({ driver }) => {
    await withCaseDatabase(driver, () => {}, database => runOn(database.dsn, () => {}, run));
  };
}
await runCases('coverage_request_hook.mjs', coverage, DATABASE);
