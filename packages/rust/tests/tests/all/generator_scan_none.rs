//! The generator scan recipe, contracts/fixtures/generator_scan/generator_scan.json, without a database (docs/spec/feature-coverage.md FCV-3).
//! Requirements: DSL-44, DSL-151, DSL-152.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::trials("generator_scan_none", "contracts/fixtures/generator_scan/generator_scan.json", recipe::NONE)
}
