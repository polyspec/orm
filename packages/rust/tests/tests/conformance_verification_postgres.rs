// Requirements: DIA-24, INT-39, PRT-77.
//! The conformance_verification recipe, contracts/fixtures/conformance_verification/conformance_verification.json, on postgres
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::table_trials(
        "conformance_verification_postgres",
        "contracts/fixtures/conformance_verification/conformance_verification.json",
        "contracts/fixtures/conformance_verification/dbspec-set.json",
        "postgres",
    ));
}
