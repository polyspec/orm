use polyspec_orm_testcase::{case, PROCESS};
use std::fs;
use std::process::Command;

fn run_fixture(id: &str) {
    let root = polyspec_orm_testcase::manifest_dir().join("../../..");
    let lease = std::env::var("LEASE").expect("LEASE is unset; run through tests/cargo-test.mts and make");
    let leases = std::env::var("CARGO_LEASES").expect("CARGO_LEASES is unset; run through tests/cargo-test.mts and make");
    let features = std::env::var("ORM_RUST_TEST_FEATURES").expect("ORM_RUST_TEST_FEATURES is unset; run through make");
    let toolchain_file = fs::read_to_string(root.join("rust-toolchain.toml")).expect("read rust-toolchain.toml from the checkout");
    let toolchain =
        toolchain_file.lines().find_map(|line| line.trim().strip_prefix("channel = \"")?.strip_suffix('"')).expect("rust-toolchain.toml has no pinned channel");
    let runner = root.join("scripts/rust/compiler-fixtures.mts");
    let status = Command::new(lease)
        .args(["run", &leases, "exclusive", "--wait", "--", "node", runner.to_str().expect("runner path is valid UTF-8"), toolchain, "--case", id])
        .env("ORM_RUST_TEST_FEATURES", features)
        .status()
        .expect("run selected compiler fixture under the cargo target lease");
    assert!(status.success(), "Rust compiler fixture {id} failed: {status}");
}

// Requirements: DSL-124.
#[test]
fn dsl124_db_begin_is_not_public() {
    let _case = case!(PROCESS);
    run_fixture("dsl124-db-begin-e0599");
}

// Requirements: DSL-124.
#[test]
fn dsl124_db_commit_is_not_public() {
    let _case = case!(PROCESS);
    run_fixture("dsl124-db-commit-e0599");
}

// Requirements: DSL-124.
#[test]
fn dsl124_db_rollback_is_not_public() {
    let _case = case!(PROCESS);
    run_fixture("dsl124-db-rollback-e0599");
}

// Requirements: DSL-50.
#[test]
fn dsl50_ordering_list_is_rejected() {
    let _case = case!(PROCESS);
    run_fixture("dsl50-ordering-list-e0277");
}
