// Requirements: DSL-159.
//! The complex_query recipe, contracts/fixtures/complex_query/complex_query.json, on sqlite
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::table_trials(
        "complex_query_sqlite",
        "contracts/fixtures/complex_query/complex_query.json",
        "contracts/fixtures/complex_query/dbspec-set.json",
        "sqlite",
    )
}
