// Requirements: DBS-108, SCH-7, FCV-3, FCV-4 (docs/spec/feature-coverage.md).
//! The recipe tests/dbspec/set-decimal.json on mysql (docs/spec/feature-coverage.md FCV-3).

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::table_trials(
        "dbspec_set_decimal_mysql",
        "tests/dbspec/set-decimal.json",
        "contracts/fixtures/dbspec-set.json",
        "mysql",
    ));
}
