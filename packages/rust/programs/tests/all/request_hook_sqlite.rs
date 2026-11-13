// Recipe conversion of the request hook: FCV-8, FCV-9, FCV-10,
// FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
// Requirements: INT-78, PRT-2, PRT-65, DIA-161.
//! The request_hook recipe, contracts/fixtures/request_hook/request_hook.json, on sqlite
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::table_trials(
        "request_hook_sqlite",
        "contracts/fixtures/request_hook/request_hook.json",
        "contracts/fixtures/request_hook/dbspec-set.json",
        "sqlite",
    )
}
