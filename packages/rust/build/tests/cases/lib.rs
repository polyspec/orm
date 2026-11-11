//! The test cases of this package, which the one Rust test program packages/rust/tests/tests/all runs as groups: each module
//! lists its trials, `<module>::<name>`.
pub mod catalog_driver_seam;
pub mod generate;
pub mod lock_probe;
pub mod lock_probe_order;
#[path = "common/physical_fixture.rs"]
pub mod physical_fixture;
pub mod row_commit_permit;
pub mod row_insert_identity;
pub mod row_mutation;
pub mod row_snapshot;
pub mod tool_cells;
pub mod tool_columns;
pub mod tool_limits;
pub mod tool_statement;
pub mod tool_values;
pub mod typed_binds;
