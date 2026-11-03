//! The dsn_connection recipe, contracts/fixtures/dsn_connection/dsn_connection.json, on sqlite
//! (docs/spec/feature-coverage.md FCV-3).
//! Requirements: CFG-1, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, CFG-2, CFG-26, DIA-57, DSL-141, CFG-12, CFG-13, CFG-24, DIA-192, DIA-193, DIA-194, DIA-195, DIA-196, PRT-74.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::table_trials(
        "dsn_connection_sqlite",
        "contracts/fixtures/dsn_connection/dsn_connection.json",
        "contracts/fixtures/catalog_connection/dbspec-set.json",
        "sqlite",
    ));
}
