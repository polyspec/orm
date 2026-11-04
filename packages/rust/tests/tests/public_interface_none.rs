//! The public interface recipe, contracts/fixtures/public_interface/public_interface.json, without a database
//! (docs/spec/feature-coverage.md FCV-3).
//! Requirements: INT-17, INT-18, INT-19, INT-57, INT-61, INT-64, INT-74, INT-88, INT-89, INT-130.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("public_interface_none", "contracts/fixtures/public_interface/public_interface.json", "none"));
}
