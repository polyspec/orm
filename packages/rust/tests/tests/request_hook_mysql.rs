// Recipe conversion of the request hook: FCV-8, FCV-9, FCV-10,
// FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
//! The request_hook recipe, contracts/fixtures/request_hook/request_hook.json, on mysql
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials("request_hook_mysql", "contracts/fixtures/request_hook/request_hook.json", "mysql"));
}
