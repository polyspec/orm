//! Coverage and result-chain tests of the generated models on SQLite, MySQL and
//! PostgreSQL. The models come from the same build as the integration program
//! (src/integration.rs); each module here is one feature's cases, run by
//! `cargo test --test integration`.
polyspec_orm::models!();

mod coverage_complex_query;
mod coverage_composite_keys;
mod coverage_constraints_and_relations;
#[path = "../common/coverage_database.rs"]
mod coverage_database;
mod coverage_env;
mod coverage_group_rows_db;
mod coverage_model_queries;
mod coverage_model_writes;
mod coverage_parameter_chunking;
mod coverage_schema_install;
mod coverage_transactions;
mod result_chains;
#[path = "../common/result_code.rs"]
mod result_code;
#[path = "../common/table_exists.rs"]
mod table_exists;
#[path = "../common/temp_sqlite.rs"]
mod temp_sqlite;
