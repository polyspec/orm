//! The read answer recipe, tests/ir/answers.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: PRT-69, PRT-71, PRT-72.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("ir_answers", "tests/ir/answers.json", recipe::NONE));
}
