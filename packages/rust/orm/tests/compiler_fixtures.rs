//! The Rust compiler fixtures of packages/rust/testing/compiler-fixtures/cases.json, one libtest-mimic trial
//! `compiler_fixtures::<id>` per case: scripts/rust/compiler-fixtures.mts compiles the consumer of the case against the
//! generated model under the cargo target lease, and the case declares its requirements in the file.
//! Requirements: INT-78, DBS-112, DBS-114, DBS-174, DSL-10, DSL-19, DSL-47, DSL-49, DSL-50, DSL-67, DSL-96, DSL-98, DSL-123, DSL-124, PLN-4, PLN-19, PRT-14.

use polyspec_orm_testcase::Trial;
use std::fs;
use std::process::Command;

#[derive(serde::Deserialize)]
struct Fixture {
    id: String,
}

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
        .current_dir(&root)
        .env("ORM_RUST_TEST_FEATURES", features)
        .status()
        .expect("run selected compiler fixture under the cargo target lease");
    assert!(status.success(), "Rust compiler fixture {id} failed: {status}");
}

fn main() {
    let path = polyspec_orm_testcase::manifest_dir().join("../testing/compiler-fixtures/cases.json");
    let fixtures: Vec<Fixture> = serde_json::from_slice(&fs::read(path).expect("compiler-fixtures/cases.json")).expect("compiler-fixtures/cases.json");
    assert!(!fixtures.is_empty(), "compiler-fixtures/cases.json has no case");
    // Each case takes the exclusive lease of the cargo target before its compile, and waits for it when another run holds it. That wait has
    // no deadline: the case's deadline is set by scripts/rust/compiler-fixtures.mts (PROCESS), which starts under the lease and covers the compile only.
    let trials: Vec<Trial> = fixtures
        .into_iter()
        .map(|fixture| {
            let name = format!("compiler_fixtures::{}", fixture.id);
            Trial::test(name, move || {
                run_fixture(&fixture.id);
                Ok(())
            })
        })
        .collect();
    polyspec_orm_testcase::run_in_order(trials);
}
