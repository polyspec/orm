//! The dsn_connection recipe, contracts/fixtures/dsn_connection/dsn_connection.json, on mysql
//! (docs/spec/feature-coverage.md FCV-3).
//! Requirements: CFG-1, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, CFG-16, CFG-2, DIA-57, DSL-141, CFG-6, CFG-21, CFG-22, CFG-23, CFG-25.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials("dsn_connection_mysql", "contracts/fixtures/dsn_connection/dsn_connection.json", "mysql"));
}
