//! Requirements: FCV-3, FCV-4, FCV-9, FCV-13, CFG-10, CFG-19.
//! The model_socket recipe, contracts/fixtures/model_socket/model_socket.json, on mysql (docs/spec/feature-coverage.md FCV-3).

use polyspec_orm_tests::recipe;

// The generated models of the bench set, as `crate::model`, which the dispatcher of the model ops calls (FCV-4).
polyspec_orm::models!();

#[path = "model_writes/dispatch.rs"]
mod dispatch;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials_with_models(
        "model_socket_mysql",
        "contracts/fixtures/model_socket/model_socket.json",
        "mysql",
        dispatch::models,
    ));
}
