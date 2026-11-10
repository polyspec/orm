//! The dsn_connection recipe, contracts/fixtures/dsn_connection/dsn_connection.json, on MariaDB, a server of the MySQL dialect (docs/spec/dialects.md DIA-200)
//! (docs/spec/feature-coverage.md FCV-3).
//! Requirements: CFG-1, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, CFG-16, CFG-2, DIA-57, DSL-141, CFG-6, CFG-21, CFG-22, CFG-23, CFG-25, CFG-24, PLN-31, DIA-192, DIA-193, DIA-194, DIA-195, DIA-196, PRT-74.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::table_trials(
        "dsn_connection_mariadb",
        "contracts/fixtures/dsn_connection/dsn_connection.json",
        "contracts/fixtures/catalog_connection/dbspec-set.json",
        "mariadb",
    )
}
