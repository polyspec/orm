//! The `hashes` cases of tests/dbspec/cases.json and the repeated document
//! name rule through `dbspec::manifest`, and the `sets` cases through
//! `dbspec::manifest` and `dbspec::render`.

use orm_schema::dbspec::{self, Diagnostic, Dialect, Document};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const DEADLINE: Duration = Duration::from_secs(10);

const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

fn text(lines: &Value) -> String {
    lines.as_array().unwrap().iter().map(|l| format!("{}\n", l.as_str().unwrap())).collect()
}

fn parsed(id: &str, text: &str, set: &BTreeMap<String, String>) -> Document {
    dbspec::parse(text, set).unwrap_or_else(|errors| panic!("{id}: {errors:?}"))
}

fn expect(case: &Value, documents: &[&Document]) {
    let id = case["id"].as_str().unwrap();
    let manifest = dbspec::manifest(documents).unwrap_or_else(|errors| panic!("{id}: {errors:?}"));
    assert_eq!(manifest.manifest_text, text(&case["manifestText"]), "{id}: manifest text");
    assert_eq!(manifest.schema_text, text(&case["schemaText"]), "{id}: schema text");
    assert_eq!(manifest.manifest_hash, case["manifestHash"].as_str().unwrap(), "{id}: manifest hash");
    assert_eq!(manifest.schema_hash, case["schemaHash"].as_str().unwrap(), "{id}: schema hash");
}

fn cases() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/dbspec/cases.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn located(errors: &[Diagnostic]) -> Vec<(String, usize, usize)> {
    errors.iter().map(|e| (e.rule.clone(), e.line, e.column)).collect()
}

#[test]
fn manifest_vectors() {
    let started = Instant::now();
    println!("RUN dbspec manifest vectors");
    let cases = cases();
    let hashes = cases["hashes"].as_array().expect("hashes cases");
    assert!(!hashes.is_empty(), "tests/dbspec/cases.json has no hashes cases");
    for case in hashes {
        let id = case["id"].as_str().unwrap();
        let documents_value = case["documents"].as_object().unwrap();
        let documents: Vec<Document> = documents_value
            .iter()
            .map(|(name, lines)| {
                let set = documents_value.iter().filter(|(other, _)| *other != name).map(|(other, l)| (other.clone(), text(l))).collect();
                parsed(id, &text(lines), &set)
            })
            .collect();
        let mut refs: Vec<&Document> = documents.iter().collect();
        expect(case, &refs);
        // The set is ordered by document name, not by the order given.
        refs.reverse();
        expect(case, &refs);
        println!("PASS hashes/{id}");
    }
    assert!(started.elapsed() < DEADLINE, "dbspec manifest vectors exceeded {DEADLINE:?}");
    println!("PASS dbspec manifest vectors {} cases {:?}", hashes.len(), started.elapsed());
}

#[test]
fn manifest_rejects_repeated_document_name() {
    let started = Instant::now();
    println!("RUN dbspec manifest repeated name");
    let source = "dbspec 1 shop\n\ntable users {\n  id i64 identity\n  primary key (id)\n}\n";
    let first = parsed("first", source, &BTreeMap::new());
    let second = parsed("second", source, &BTreeMap::new());
    let errors = dbspec::manifest(&[&first, &second]).expect_err("a set that repeats a document name has no manifest");
    let got: Vec<(&str, usize, usize)> = errors.iter().map(|e| (e.rule.as_str(), e.line, e.column)).collect();
    assert_eq!(got, vec![("name.duplicate", 1, 10)]);
    assert!(started.elapsed() < DEADLINE);
    println!("PASS dbspec manifest repeated name {:?}", started.elapsed());
}

#[test]
fn set_vectors() {
    let started = Instant::now();
    println!("RUN dbspec set vectors");
    let cases = cases();
    let sets = cases["sets"].as_array().expect("sets cases");
    assert!(!sets.is_empty(), "tests/dbspec/cases.json has no sets cases");
    for case in sets {
        let id = case["id"].as_str().unwrap();
        let texts: Vec<String> = case["documents"].as_array().unwrap().iter().map(text).collect();
        let parsing: BTreeMap<String, String> = case["parsing"].as_object().unwrap().iter().map(|(name, l)| (name.clone(), text(l))).collect();
        let documents: Vec<Document> = texts
            .iter()
            .enumerate()
            .map(|(i, source)| {
                let mut set = parsing.clone();
                for (j, other) in texts.iter().enumerate() {
                    if j != i {
                        let header = other.lines().next().unwrap();
                        let name = header.strip_prefix("dbspec 1 ").unwrap_or_else(|| panic!("{id}: header {header:?}"));
                        set.insert(name.to_owned(), other.clone());
                    }
                }
                parsed(id, source, &set)
            })
            .collect();
        let refs: Vec<&Document> = documents.iter().collect();
        let want: Vec<(String, usize, usize)> = case["errors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (e["rule"].as_str().unwrap().to_owned(), e["line"].as_u64().unwrap() as usize, e["column"].as_u64().unwrap() as usize))
            .collect();
        match dbspec::manifest(&refs) {
            Ok(_) => assert!(want.is_empty(), "{id}: manifest gave no errors, want {want:?}"),
            Err(errors) => {
                assert!(!want.is_empty(), "{id}: manifest gave {errors:?}");
                assert_eq!(located(&errors), want, "{id}: manifest");
            }
        }
        for (dialect_name, dialect) in DIALECTS {
            match dbspec::render(&refs, dialect) {
                Ok(_) => assert!(want.is_empty(), "{id}: {dialect_name} rendered, want {want:?}"),
                Err(errors) => {
                    assert!(!want.is_empty(), "{id}: {dialect_name} gave {errors:?}");
                    assert_eq!(located(&errors), want, "{id}: {dialect_name}");
                }
            }
        }
        println!("PASS sets/{id}");
    }
    assert!(started.elapsed() < DEADLINE, "dbspec set vectors exceeded {DEADLINE:?}");
    println!("PASS dbspec set vectors {} cases {:?}", sets.len(), started.elapsed());
}
