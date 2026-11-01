// Requirements: FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14, DBS-104, DBS-107, DBS-108, DBS-119, DBS-120, INT-54, INT-55, INT-132, INT-133, PLN-44, SCH-7, SCH-10, SCH-11
//! The schema_install recipe, contracts/fixtures/schema_install/schema_install.json, on postgres
//! (docs/spec/feature-coverage.md FCV-3).
//! Requirements: DBS-104, DBS-107, DBS-108, DBS-119, DBS-120, INT-54, INT-55, INT-132, INT-133, PLN-44, SCH-7, SCH-10,
//! SCH-11.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials("schema_install_postgres", "contracts/fixtures/schema_install/schema_install.json", "postgres"));
}
