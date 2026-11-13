//! Requirements: PLN-89, PLN-90, PLN-91, PLN-92, PLN-93, PLN-94, PLN-95, PLN-96, PLN-104, PLN-105.
//! The dbspec_apply recipe, contracts/fixtures/dbspec_apply/dbspec_apply.json, on mysql (docs/spec/feature-coverage.md FCV-3).

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::database_trials("dbspec_apply_mysql", "contracts/fixtures/dbspec_apply/dbspec_apply.json", "mysql")
}
