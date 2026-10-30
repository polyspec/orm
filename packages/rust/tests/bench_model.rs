//! The document set and the scan paths of the bench model, from the crate root. build.rs generates the model from them, and
//! tests/coverage_model_generation.rs generates it again from the same list and compares the two.

/// The document set of the bench model.
pub const SET: &str = "../../../contracts/fixtures/bench/dbspec-set.json";

/// The directories whose sources the generator scans for the chain methods they call.
pub const SCAN: &[&str] = &["src", "tests/integration", "tests/integration_program", "../../../examples/complex/rust", "../../../examples/thin-slice/rust"];
