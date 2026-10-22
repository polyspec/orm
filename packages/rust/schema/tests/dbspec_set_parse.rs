//! The set parse vectors (tests/dbspec/set-parse.json, docs/spec/dbspec.md "Parsing a set").
//!
//! Each case calls `dbspec::parse_set` with its owned and external texts and compares, per text,
//! the name read from the header, the external mark, whether a document was parsed and the
//! diagnostics. A vector diagnostic without a message compares its
//! rule, line and column only.

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

use polyspec_orm_schema::dbspec::{self, Diagnostic};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

// SUITE_DEADLINE is the CPU time limit of the test; the wall-clock deadline that ends a stuck test is
// ten times it (polyspec_orm_testcase::wall_for_cpu).
const SUITE_DEADLINE: Duration = Duration::from_secs(5);

fn vectors_path() -> PathBuf {
    polyspec_orm_testcase::manifest_dir().join("../../../tests/dbspec/set-parse.json")
}

fn texts(value: &Value, what: &str) -> Vec<String> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("{what}: not an array"))
        .iter()
        .map(|v| v.as_str().unwrap_or_else(|| panic!("{what}: not a string")).to_owned())
        .collect()
}

fn check_diagnostics(got: &[Diagnostic], want: &Value, what: &str) {
    let want = want.as_array().unwrap_or_else(|| panic!("{what}: not an array"));
    assert_eq!(got.len(), want.len(), "{what}: diagnostics {got:?}");
    for (g, w) in got.iter().zip(want) {
        assert_eq!(g.rule, w["rule"].as_str().unwrap(), "{what}: rule of {g:?}");
        assert_eq!(g.line as u64, w["line"].as_u64().unwrap(), "{what}: line of {g:?}");
        assert_eq!(g.column as u64, w["column"].as_u64().unwrap(), "{what}: column of {g:?}");
        if let Some(message) = w.get("message") {
            assert_eq!(g.message, message.as_str().unwrap(), "{what}: message of {g:?}");
        }
    }
}

/// One trial for each case of set-parse.json, `shared_set_parse_vectors::<id>`: the case gives its documents and no set
/// diagnostics.
fn shared_set_parse_vectors() -> Vec<polyspec_orm_testcase::Trial> {
    let path = vectors_path();
    let file: Value = serde_json::from_slice(&std::fs::read(&path).or_panic(|e| format!("{}: {e}", path.display()))).unwrap();
    assert_eq!(file["schema"], 1, "set-parse.json schema");
    let cases = file["cases"].as_array().expect("cases are listed");
    assert!(!cases.is_empty(), "cases are not empty");
    cases
        .iter()
        .map(|case| {
            let id = case["id"].as_str().expect("a case has an id").to_owned();
            let case = case.clone();
            polyspec_orm_testcase::trial(format!("shared_set_parse_vectors::{id}"), polyspec_orm_testcase::wall_for_cpu(SUITE_DEADLINE), move || {
                check_case(&case)
            })
        })
        .collect()
}

fn check_case(case: &Value) {
    let name = case["name"].as_str().expect("a case has a name");
    let owned = texts(&case["owned"], name);
    let external = texts(&case["external"], name);
    let owned: Vec<&str> = owned.iter().map(String::as_str).collect();
    let external: Vec<&str> = external.iter().map(String::as_str).collect();
    let got = dbspec::parse_set(&owned, &external);
    assert!(case.get("diagnostics").is_none(), "{name}: a case has no set diagnostics");
    let want = case["documents"].as_array().expect("documents are listed");
    assert_eq!(got.len(), want.len(), "{name}: documents");
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        let what = format!("{name}: document {i}");
        assert_eq!(g.name.as_deref().unwrap_or(""), w["name"].as_str().unwrap(), "{what}: name");
        assert_eq!(g.external, w["external"].as_bool().unwrap(), "{what}: external");
        assert_eq!(g.document.is_some(), w["parsed"].as_bool().unwrap(), "{what}: parsed");
        if let Some(document) = &g.document {
            assert_eq!(document.external, g.external, "{what}: document external");
        }
        check_diagnostics(&g.diagnostics, &w["diagnostics"], &what);
    }
}

fn main() {
    polyspec_orm_testcase::run(shared_set_parse_vectors());
}
