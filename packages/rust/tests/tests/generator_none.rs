//! The generator recipe, contracts/fixtures/generator/generator.json, without a database (docs/spec/feature-coverage.md FCV-3).
//! Requirements: DSL-37, DSL-116, DSL-127, DSL-129, DSL-130, PLN-22.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("generator_none", "contracts/fixtures/generator/generator.json", recipe::NONE));
}
