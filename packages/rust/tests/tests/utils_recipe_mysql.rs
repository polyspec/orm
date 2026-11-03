//! Requirements: INT-51, INT-52, INT-53, INT-61, INT-73, INT-134, CFG-30, INT-50.
//! The utils recipe, contracts/fixtures/utils/utils.json, on mysql (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::table_trials(
        "utils_recipe_mysql",
        "contracts/fixtures/utils/utils.json",
        "contracts/fixtures/statement_events/dbspec-set.json",
        "mysql",
    ));
}
