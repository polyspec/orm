//! The chain value recipe, contracts/fixtures/dsl/dsl.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: DSL-49, DSL-50, PLN-4.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::trials("dsl_none", "contracts/fixtures/dsl/dsl.json", recipe::NONE)
}
