//! The test cases of this package, which the one Rust test program packages/rust/tests/tests/all runs as groups: each module
//! lists its trials, `<module>::<name>`.
#[macro_use]
#[path = "common/audit_rows.rs"]
pub mod audit_rows;
#[macro_use]
#[path = "common/map_rows.rs"]
pub mod map_rows;
#[macro_use]
#[path = "common/typed_model.rs"]
pub mod typed_model;
pub mod aes_keys;
pub mod audit;
#[path = "common/case_database_run.rs"]
pub mod case_database_run;
#[path = "common/clock_event.rs"]
pub mod clock_event;
#[path = "common/clock_test_support.rs"]
pub mod clock_test_support;
pub mod code_catalog;
pub mod collection_identity;
pub mod compiler_fixtures;
pub mod identity_load;
pub mod mysql_tls;
#[path = "common/or_panic.rs"]
pub mod or_panic;
pub mod package_entry;
#[path = "common/result_code.rs"]
pub mod result_code;
pub mod rollback;
#[path = "common/secret_config.rs"]
pub mod secret_config;
#[path = "common/service_model.rs"]
pub mod service_model;
#[path = "common/sqlite_case.rs"]
pub mod sqlite_case;
pub mod sqlite_concurrency;
pub mod statement_fault;
pub mod styled_column_states;
pub mod transaction_flow;
pub mod value_types;
pub mod was_inserted;
pub mod zone;
