// Requirements: COD-7, COD-8, PLN-44, INT-60, INT-75, INT-131.
// Recipe conversion of the AES rotation: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit aes_rotation-postgres.
//! The aes_rotation recipe, contracts/fixtures/aes_rotation/aes_rotation.json, on postgres
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::table_trials(
        "aes_rotation_postgres",
        "contracts/fixtures/aes_rotation/aes_rotation.json",
        "contracts/fixtures/aes_rotation/dbspec-set.json",
        "postgres",
    )
}
