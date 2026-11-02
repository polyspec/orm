// Recipe conversion of the AES rotation: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit aes_rotation-sqlite.
//! INT-151: on SQLite a text stored in an INTEGER or REAL column is a text grid cell; the recipe expects it at step 16 of read_path_codes, rotation_path_codes and stored_version_text. Requirement: INT-151.
//! The aes_rotation recipe, contracts/fixtures/aes_rotation/aes_rotation.json, on sqlite
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials("aes_rotation_sqlite", "contracts/fixtures/aes_rotation/aes_rotation.json", "sqlite"));
}
