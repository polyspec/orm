//! Requirements: CFG-33, INT-87, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14.
//! The constraints_and_relations recipe, contracts/fixtures/constraints_and_relations/constraints_and_relations.json, on sqlite (docs/spec/feature-coverage.md FCV-3, FCV-4).

use polyspec_orm_tests::recipe;

// The generated models of the bench set, as `crate::model`, which the dispatcher of the model ops calls (FCV-4).
polyspec_orm::models!();

#[path = "../src/bench_set_dispatch.rs"]
mod dispatch;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials_with_models(
        "constraints_and_relations_sqlite",
        "contracts/fixtures/constraints_and_relations/constraints_and_relations.json",
        "sqlite",
        dispatch::models,
    ));
}
