//! The immutable_write recipe, contracts/fixtures/immutable_write/immutable_write.json, on MariaDB, a server of the MySQL dialect (docs/spec/dialects.md DIA-200)
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).
//! Requirements: DBS-84.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::table_trials(
        "immutable_write_mariadb",
        "contracts/fixtures/immutable_write/immutable_write.json",
        "contracts/fixtures/immutable_write/dbspec-set.json",
        "mariadb",
    )
}
