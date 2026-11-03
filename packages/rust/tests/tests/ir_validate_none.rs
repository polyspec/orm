//! The request validation recipe, tests/ir/validate.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4). Each case
//! of the recipe is the trial ir_validate_none::<case id>, whose ir.validate steps run through the shared runner.
//! Requirements: PRT-1, INT-24, PRT-4, PRT-6, PRT-8, PRT-10, PRT-12, PRT-14, PRT-16, PRT-17, PRT-18, PRT-20, PRT-21, PRT-22, PRT-24, PRT-78,
//! DBS-59, DBS-113, DSL-113, DSL-128.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("ir_validate_none", "tests/ir/validate.json", recipe::NONE));
}
