//! The performance_gate recipe, contracts/fixtures/performance_gate/performance_gate.json, on postgres
//! (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: PERF-1.

use polyspec_orm_tests::recipe;

// The generated models of the bench set, as `crate::model`, which the dispatcher of the model ops calls (FCV-4).
polyspec_orm::models!();

#[path = "model_writes/dispatch.rs"]
mod dispatch;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials_with_models(
        "performance_gate_postgres",
        "contracts/fixtures/performance_gate/performance_gate.json",
        "postgres",
        dispatch::models,
    ));
}
