// request_hook coverage: each case of request_hook_run.mjs runs on the database that feature-check chose (ORM_FEATURE_DATABASE)
// in a new case database (case-database.mjs). It does not read or write the database of ORM_FEATURE_DSN. The output is
// only the lines of the passing cases.
import { DATABASE } from '../../../tests/testcase.mts';
import { withCaseDatabase } from './case-database.mjs';
import { runCases } from './coverage_case.mjs';
import { cases, runOn } from './request_hook_run.mjs';

// Requirements, by case of request_hook_run.mjs (each case runs in every database item of this file):
// without_hook: Requirements: CFG-9.
// read_filter: Requirements: DSL-65, PRT-2.
// insert_assign: Requirements: PRT-4, PRT-5, PRT-41.
// loaded_row_writes: Requirements: CFG-21, INT-36, INT-37, PLN-16.
// invalid_param: Requirements: PRT-65.
// restore_key: Requirements: DIA-161.
// restore_condition: Requirements: DIA-161, INT-38.
// restore_no_key: Requirements: DIA-161.
// restore_rewritten_key: Requirements: DIA-161.
// restore_hook_set_key: Requirements: DIA-161.
// restore_rewritten_key_set_scope: Requirements: DIA-161.
const coverage = {};
for (const [name, run] of Object.entries(cases)) {
  coverage[name] = async ({ driver }) => {
    await withCaseDatabase(driver, () => {}, database => runOn(database.dsn, () => {}, run));
  };
}
await runCases('coverage_request_hook.mjs', coverage, DATABASE);
