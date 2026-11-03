//! The entities of the runtime model, tests/dbspec/runtime-model.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: DBS-65, DBS-85, DBS-111, DBS-112, DBS-100, DBS-103.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("runtime_model_entities_none", "tests/dbspec/runtime-model.json", recipe::NONE));
}
