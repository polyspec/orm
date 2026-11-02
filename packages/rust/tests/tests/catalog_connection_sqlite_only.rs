// Requirements: INT-103
//! The catalog_connection sqlite-only recipe, contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json,
//! on sqlite (docs/spec/feature-coverage.md FCV-3).

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials("catalog_connection_sqlite_only", "contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json", "sqlite"));
}
