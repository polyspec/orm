//! Requirements: FCV-8, FCV-9, FCV-10, FCV-13, FCV-14.
//! The model_writes recipe, contracts/fixtures/model_writes/model_writes.json, on sqlite (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-109, DSL-110, PLN-26.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::database_trials_with_models(
        "model_writes_sqlite",
        "contracts/fixtures/model_writes/model_writes.json",
        "sqlite",
        crate::model_writes_dispatch::models,
    )
}
