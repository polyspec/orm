// Requirements: DIA-113, FCV-22, FCV-4 (docs/spec/feature-coverage.md).
//! The recipe tests/dbspec/render-physical.json on mysql (docs/spec/feature-coverage.md FCV-22).

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::database_trials("dbspec_render_physical_mysql", "tests/dbspec/render-physical.json", "mysql")
}
