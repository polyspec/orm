//! The add tables steps of the recipe tests/dbspec/add-tables-steps.json without a database (docs/spec/feature-coverage.md FCV-3,
//! FCV-4): each case is the trial dbspec_add_tables_steps_none::<case id>, whose steps run through the shared runner.
//! Requirements: INT-56, SCH-8.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::trials("dbspec_add_tables_steps_none", "tests/dbspec/add-tables-steps.json", recipe::NONE)
}
