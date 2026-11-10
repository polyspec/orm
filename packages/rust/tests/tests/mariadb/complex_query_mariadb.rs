//! The complex_query recipe, contracts/fixtures/complex_query/complex_query.json, on MariaDB, a server of the MySQL dialect (docs/spec/dialects.md DIA-200)
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::table_trials(
        "complex_query_mariadb",
        "contracts/fixtures/complex_query/complex_query.json",
        "contracts/fixtures/complex_query/dbspec-set.json",
        "mariadb",
    )
}
