// Recipe conversion of the AES rotation: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit aes_rotation-postgres.
//! The aes_rotation recipe, contracts/fixtures/aes_rotation/aes_rotation.json, on postgres
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials("aes_rotation_postgres", "contracts/fixtures/aes_rotation/aes_rotation.json", "postgres"));
}
