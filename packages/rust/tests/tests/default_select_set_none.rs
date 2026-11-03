//! The default select set, tests/planner/default-select-set.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: PRT-9, DBS-68.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("default_select_set_none", "tests/planner/default-select-set.json", recipe::NONE));
}
