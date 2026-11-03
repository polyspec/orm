//! The conformance_verification recipe, contracts/fixtures/conformance_verification/conformance_verification.json, on sqlite
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::table_trials(
        "conformance_verification_sqlite",
        "contracts/fixtures/conformance_verification/conformance_verification.json",
        "contracts/fixtures/conformance_verification/dbspec-set.json",
        "sqlite",
    ));
}
