//! Requirements: FCV-8, FCV-9, FCV-10, FCV-13, FCV-14.
//! The model_writes recipe, contracts/fixtures/model_writes/model_writes.json, on mysql (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-109, DSL-110, PLN-26.

use polyspec_orm_tests::recipe;

// The generated models of the bench set, as `crate::model`, which the dispatcher of the model ops calls (FCV-4).
polyspec_orm::models!();

#[path = "model_writes/dispatch.rs"]
mod dispatch;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials_with_models(
        "model_writes_mysql",
        "contracts/fixtures/model_writes/model_writes.json",
        "mysql",
        dispatch::models,
    ));
}
