// Requirements: DIA-113, FCV-3, FCV-4 (docs/spec/feature-coverage.md).
//! The recipe tests/dbspec/render-physical.json on mysql (docs/spec/feature-coverage.md FCV-3).

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials("dbspec_render_physical_mysql", "tests/dbspec/render-physical.json", "mysql"));
}
