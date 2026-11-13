//! The composite_keys recipe, contracts/fixtures/composite_keys/composite_keys.json, on postgres (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: DSL-82, INT-87, PRT-12, PRT-40.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::database_trials_with_models(
        "composite_keys_postgres",
        "contracts/fixtures/composite_keys/composite_keys.json",
        "postgres",
        crate::model_writes_dispatch::models,
    )
}
