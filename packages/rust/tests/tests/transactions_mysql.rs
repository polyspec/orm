//! The transactions recipe, contracts/fixtures/transactions/transactions.json, on mysql (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: CFG-15, CFG-24, INT-155, DSL-118, DSL-119, DSL-123, DSL-125, DSL-126, INT-40, INT-41, INT-42, INT-43, INT-45, INT-46, INT-49, INT-48,
//! PLN-13, PLN-16, PLN-17, PLN-20, PLN-21, PLN-24, PLN-44.

use polyspec_orm_tests::recipe;

// The generated models of the bench set, as `crate::model`, which the dispatcher of the model ops calls (FCV-4).
polyspec_orm::models!();

#[path = "model_writes/dispatch.rs"]
mod dispatch;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials_with_models(
        "transactions_mysql",
        "contracts/fixtures/transactions/transactions.json",
        "mysql",
        dispatch::models,
    ));
}
