//! Requirements: FCV-3, FCV-4, FCV-9, FCV-13, CFG-10, CFG-19.
//! The model_socket recipe, contracts/fixtures/model_socket/model_socket.json, on mysql (docs/spec/feature-coverage.md FCV-3).

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::database_trials_with_models(
        "model_socket_mysql",
        "contracts/fixtures/model_socket/model_socket.json",
        "mysql",
        crate::model_writes_dispatch::models,
    )
}
