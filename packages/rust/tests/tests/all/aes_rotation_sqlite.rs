// Requirements: COD-7, COD-8, PLN-44, INT-60, INT-75, INT-131.
// Recipe conversion of the AES rotation: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit aes_rotation-sqlite.
//! INT-152: on SQLite a text stored in an INTEGER or REAL column is a text grid cell; the recipe expects it at step 16 of read_path_codes, rotation_path_codes and stored_version_text. Requirement: INT-152.
//! The aes_rotation recipe, contracts/fixtures/aes_rotation/aes_rotation.json, on sqlite
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::table_trials(
        "aes_rotation_sqlite",
        "contracts/fixtures/aes_rotation/aes_rotation.json",
        "contracts/fixtures/aes_rotation/dbspec-set.json",
        "sqlite",
    )
}
