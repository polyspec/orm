//! The composite_keys recipe, contracts/fixtures/composite_keys/composite_keys.json, on sqlite (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: DSL-82, INT-87, PRT-12, PRT-40.

use polyspec_orm_tests::recipe;

// The generated models of the bench set, as `crate::model`, which the dispatcher of the model ops calls (FCV-4).
polyspec_orm::models!();

#[path = "model_writes/dispatch.rs"]
mod dispatch;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials_with_models(
        "composite_keys_sqlite",
        "contracts/fixtures/composite_keys/composite_keys.json",
        "sqlite",
        dispatch::models,
    ));
}
