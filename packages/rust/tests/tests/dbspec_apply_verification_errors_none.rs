//! The apply verification errors of tests/dbspec/apply-verification-errors.json on a memory connection (docs/spec/feature-coverage.md FCV-3).
//! Requirements: PLN-92, PLN-93, PLN-96, PLN-100, PLN-106.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("dbspec_apply_verification_errors_none", "tests/dbspec/apply-verification-errors.json", recipe::NONE));
}
