//! The performance_gate recipe, contracts/fixtures/performance_gate/performance_gate.json, on postgres
//! (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: PERF-1.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::database_trials_with_models(
        "performance_gate_postgres",
        "contracts/fixtures/performance_gate/performance_gate.json",
        "postgres",
        crate::model_writes_dispatch::models,
    )
}
