//! Requirements: INT-51, INT-52, INT-53, INT-61, INT-73, INT-134, CFG-30, INT-50, INT-72, INT-79.
//! The utils recipe, contracts/fixtures/utils/utils.json, on markdown (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::table_trials("utils_recipe_markdown", "contracts/fixtures/utils/utils.json", "contracts/fixtures/statement_events/dbspec-set.json", "markdown")
}
