//! Coverage and result-chain tests of the generated models on SQLite, MySQL and
//! PostgreSQL. The models come from the same build as the integration program
//! (tests/integration_program); each module here is one feature's cases, run by
//! `cargo test --test integration`.
polyspec_orm::models!();

mod coverage_complex_query;
#[path = "../common/coverage_database.rs"]
mod coverage_database;
mod coverage_env;
mod result_chains;
#[path = "../common/result_code.rs"]
mod result_code;
