//! The test cases of this package, which the one Rust test program packages/rust/tests/tests/all runs as groups: each module
//! lists its trials, `<module>::<name>`.
pub mod dbspec_model;
pub mod dbspec_runtime;
pub mod dbspec_set_working_directory;
#[path = "common/or_panic.rs"]
pub mod or_panic;
