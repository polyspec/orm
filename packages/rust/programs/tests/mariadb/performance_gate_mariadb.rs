//! The performance_gate recipe, contracts/fixtures/performance_gate/performance_gate.json, on MariaDB, a server of the MySQL dialect (docs/spec/dialects.md DIA-200)
//! (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: PERF-1.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::database_trials_with_models(
        "performance_gate_mariadb",
        "contracts/fixtures/performance_gate/performance_gate.json",
        "mariadb",
        crate::model_writes_dispatch::models,
    )
}
