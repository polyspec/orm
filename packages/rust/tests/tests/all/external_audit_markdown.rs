//! The external_audit recipe, contracts/fixtures/external_audit/external_audit.json, on markdown
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).
//! Requirements: SCH-14, DBS-110.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::table_trials(
    "external_audit_markdown",
    "contracts/fixtures/external_audit/external_audit.json",
    "contracts/fixtures/external_audit/dbspec-set.json",
    "markdown",
)
}
