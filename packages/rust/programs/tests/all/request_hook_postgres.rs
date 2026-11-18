// Recipe conversion of the request hook: FCV-8, FCV-9, FCV-25,
// FCV-26, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
//! The request_hook recipe, contracts/fixtures/request_hook/request_hook.json, on postgres
//! (docs/spec/feature-coverage.md FCV-22 and FCV-4).

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::table_trials(
        "request_hook_postgres",
        "contracts/fixtures/request_hook/request_hook.json",
        "contracts/fixtures/request_hook/dbspec-set.json",
        "postgres",
    )
}
