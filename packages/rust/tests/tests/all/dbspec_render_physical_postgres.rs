// Requirements: DIA-113, FCV-3, FCV-4 (docs/spec/feature-coverage.md).
//! The recipe tests/dbspec/render-physical.json on postgres (docs/spec/feature-coverage.md FCV-3).

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::database_trials("dbspec_render_physical_postgres", "tests/dbspec/render-physical.json", "postgres")
}
