//! The refusal of a server that is not a server of the dialect, the case introspect-server-of-another-dialect of
//! tests/dbspec/dialect-refusal.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: DBS-174.
//!
//! Rust runs only this case of the recipe. Rust takes a dialect and a server by the enum types `Dialect` and `Server`, so the
//! other cases, which pass a name that is none of them (`oracle`), have no call in Rust: the compile fixtures
//! dbs174-plan-unknown-dialect-e0308 and dbs174-render-unknown-dialect-e0308 hold that refusal. The postgres dialect with the
//! MariaDB server is a value of both types, so this case is one that Rust can write.

use polyspec_orm_tests::recipe;

/// The cases of tests/dbspec/dialect-refusal.json that Rust's types can represent.
const CASES: &[&str] = &["introspect-server-of-another-dialect"];

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::trials_of_cases("dbspec_dialect_refusal_none", "tests/dbspec/dialect-refusal.json", recipe::NONE, CASES)
}
