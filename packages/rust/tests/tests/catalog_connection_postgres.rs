//! The catalog_connection recipe, contracts/fixtures/catalog_connection/catalog_connection.json, on postgres
//! (docs/spec/feature-coverage.md FCV-3).
//! Requirements: INT-101, INT-103, INT-104, INT-109, INT-111, INT-113, INT-114, INT-115, INT-117, INT-123, INT-136,
//! SCH-6a.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials(
        "catalog_connection_postgres",
        "contracts/fixtures/catalog_connection/catalog_connection.json",
        "postgres",
    ));
}
