//! The complex_query recipe, contracts/fixtures/complex_query/complex_query.json, on mysql
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::table_trials(
        "complex_query_mysql",
        "contracts/fixtures/complex_query/complex_query.json",
        "contracts/fixtures/complex_query/dbspec-set.json",
        "mysql",
    ));
}
