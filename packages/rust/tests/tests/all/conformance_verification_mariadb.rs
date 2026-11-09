// Requirements: DIA-18, DIA-24, DIA-56, DSL-137, INT-39, PRT-77.
//! The conformance_verification recipe, contracts/fixtures/conformance_verification/conformance_verification.json, on MariaDB, a server of the MySQL dialect (docs/spec/dialects.md DIA-200)
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::table_trials(
        "conformance_verification_mariadb",
        "contracts/fixtures/conformance_verification/conformance_verification.json",
        "contracts/fixtures/conformance_verification/dbspec-set.json",
        "mariadb",
    )
}
