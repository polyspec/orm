//! The external_audit recipe, contracts/fixtures/external_audit/external_audit.json, on sqlite
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).
//! Requirements: SCH-14, DBS-110.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::table_trials(
        "external_audit_sqlite",
        "contracts/fixtures/external_audit/external_audit.json",
        "contracts/fixtures/external_audit/dbspec-set.json",
        "sqlite",
    ));
}
