// Requirements: INT-103
//! The catalog_connection sqlite-only recipe, contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json,
//! on markdown (docs/spec/feature-coverage.md FCV-3).

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::database_trials("catalog_connection_sqlite_only_markdown", "contracts/fixtures/catalog_connection/catalog_connection-sqlite-only.json", "markdown")
}
