// Requirements: DBS-115, DIA-11, DIA-14, DIA-18, DIA-24, DIA-37, DIA-56, DSL-54, DSL-99, DSL-137, DSL-139, DSL-144, INT-39, PRT-77.
//! The conformance_verification recipe, contracts/fixtures/conformance_verification/conformance_verification.json, on markdown
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::table_trials(
        "conformance_verification_markdown",
        "contracts/fixtures/conformance_verification/conformance_verification.json",
        "contracts/fixtures/conformance_verification/dbspec-set.json",
        "markdown",
    ));
}
