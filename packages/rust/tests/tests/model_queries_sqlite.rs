//! Requirements: DSL-57, DSL-58, DSL-60, DSL-62, DSL-73, DSL-74, DSL-76, DSL-80, DSL-82, DSL-99, INT-16, INT-29, INT-30, INT-31, INT-32, INT-33, PLN-11, PLN-25, PRT-35.
//! Requirements: FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14.
//! The model_queries recipe, contracts/fixtures/model_queries/model_queries.json, on sqlite (docs/spec/feature-coverage.md FCV-3, FCV-4).

use polyspec_orm_tests::recipe;

// The generated models of the bench set, as `crate::model`, which the dispatcher of the model ops calls (FCV-4).
polyspec_orm::models!();

#[path = "../src/model_queries_dispatch.rs"]
mod dispatch;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials_with_models(
        "model_queries_sqlite",
        "contracts/fixtures/model_queries/model_queries.json",
        "sqlite",
        dispatch::models,
    ));
}
