//! Coverage and result-chain tests of the generated models on SQLite, MySQL and
//! PostgreSQL. The models come from the same build as the integration program
//! (src/integration.rs); each module here is one feature's cases, run by
//! `cargo test --test integration`.
polyspec_orm::models!();

mod coverage_composite_keys;
mod coverage_constraints_and_relations;
mod coverage_group_rows_db;
mod coverage_env;
mod coverage_model_queries;
mod coverage_model_writes;
mod coverage_parameter_chunking;
mod coverage_schema_install;
mod coverage_transactions;
mod result_chains;
