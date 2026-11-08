//! The transactions recipe, contracts/fixtures/transactions/transactions.json, on markdown (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: CFG-15, CFG-24, INT-155, DSL-118, DSL-119, DSL-123, DSL-125, DSL-126, INT-40, INT-41, INT-42, INT-43, INT-45, INT-46, INT-49, INT-72, INT-48,, CFG-12
//! PLN-13, PLN-16, PLN-17, PLN-20, PLN-21, PLN-24, PLN-44.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::database_trials_with_models(
    "transactions_markdown",
    "contracts/fixtures/transactions/transactions.json",
    "markdown",
    crate::model_writes_dispatch::models,
)
}
