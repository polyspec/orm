//! The conformance runner's own cases: the bodies it declares, its command line and the form of a bound value.
use std::collections::HashSet;

use polyspec_orm::Param;
use polyspec_orm_testcase::OrPanic;
use serde_json::{json, Value};

#[path = "../../src/conformance_values.rs"]
mod values;
use values::{norm, param_json, Args};

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("conformance_runner": invalid_binds_cannot_be_rendered_as_valid_values, arguments_reject_missing_duplicate_and_unknown_flags, every_body_is_a_vector_of_the_vector_file)
}

fn invalid_binds_cannot_be_rendered_as_valid_values() {
    let _case = polyspec_orm_testcase::case!();
    assert!(param_json(&Param::Bytes(vec![0xff])).is_err());
    assert!(param_json(&Param::Bytes(b"ORM-AES2\0".to_vec())).is_err());
    let mut encrypted = b"ORM-AES2\0".to_vec();
    encrypted.extend([0xff; 12 + 16]);
    assert_eq!(param_json(&Param::Bytes(encrypted)).unwrap(), json!("$AES"));
    assert!(param_json(&Param::F64(f64::INFINITY)).is_err());
    assert_eq!(param_json(&Param::Bytes(Vec::new())).unwrap(), json!(""));
    let seqs = HashSet::new();
    assert!(std::panic::catch_unwind(|| norm(&json!("ORM-AES2broken"), &seqs)).is_err());
    assert!(std::panic::catch_unwind(|| norm(&json!("4f524d2d4145533200bad"), &seqs)).is_err());
    assert!(std::panic::catch_unwind(|| norm(&json!(format!("4f524d2d41455332ff{}", "00".repeat(28))), &seqs)).is_err());
}

fn arguments_reject_missing_duplicate_and_unknown_flags() {
    let _case = polyspec_orm_testcase::case!();
    let parse = |args: &[&str]| Args::parse(&args.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>());
    let args = parse(&["--dsn", "sqlite://x", "--vector", "relations", "--vector", "conditions_values"]).unwrap();
    assert_eq!((args.dsn.as_str(), args.vectors), ("sqlite://x", vec!["relations".to_owned(), "conditions_values".to_owned()]));
    assert!(parse(&["--dsn", "sqlite://x"]).unwrap().vectors.is_empty());
    for invalid in [
        &["--vector", "relations"][..],
        &["--dsn"],
        &["--dsn", "a", "--dsn", "b"],
        &["--dsn", "a", "--vector", ""],
        &["--dsn", "a", "--vector", "relations", "--vector", "relations"],
        &["--dsn", "a", "--vectors", "relations"],
    ] {
        assert!(parse(invalid).is_err(), "{invalid:?}");
    }
}

/// Each body of this runner is declared once and is named in tests/conformance/vectors.json. A vector name with no body here
/// is a recipe case (tests/conformance/README.md). The declared names are read from this file: the first string literal after
/// each run invocation.
fn every_body_is_a_vector_of_the_vector_file() {
    let _case = polyspec_orm_testcase::case!();
    let call = "run!(";
    let declared: Vec<&str> = include_str!("../../src/conformance.rs")
        .split(call)
        .skip(1)
        .map(|rest| {
            let literal = rest.trim_start().strip_prefix('"').unwrap_or_else(|| panic!("a vector invocation has no name literal"));
            &literal[..literal.find('"').unwrap_or_else(|| panic!("a vector name literal is not closed"))]
        })
        .collect();
    let mut seen = HashSet::new();
    for name in &declared {
        assert!(seen.insert(*name), "vector {name} is declared twice");
    }
    let path = polyspec_orm_testcase::manifest_dir().join("../../../tests/conformance/vectors.json");
    let text = std::fs::read_to_string(&path).or_panic(|e| format!("{}: {e}", path.display()));
    let recorded: Value = serde_json::from_str(&text).or_panic(|e| format!("{}: {e}", path.display()));
    let vectors = recorded["vectors"].as_array().unwrap_or_else(|| panic!("{}: no vectors array", path.display()));
    let names: HashSet<&str> = vectors.iter().map(|vector| vector["name"].as_str().unwrap_or_else(|| panic!("a vector has no name"))).collect();
    for name in &declared {
        assert!(names.contains(name), "the body {name} is not a vector of {}", path.display());
    }
}
