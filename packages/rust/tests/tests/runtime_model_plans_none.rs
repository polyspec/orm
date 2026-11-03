//! The plans of the runtime model, tests/planner/runtime-model.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: DBS-112, PRT-32, PRT-81, PRT-82, DIA-24, PRT-33, DBS-67.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("runtime_model_plans_none", "tests/planner/runtime-model.json", recipe::NONE));
}
