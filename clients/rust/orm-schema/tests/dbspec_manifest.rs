//! The `hashes` cases of tests/dbspec/cases.json and the repeated document
//! name rule through `dbspec::manifest`, and the `sets` cases through
//! `dbspec::manifest` and `dbspec::render`.

use orm_case_clock::CaseClock;
use orm_schema::dbspec::{self, Diagnostic, Dialect, Document};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::Duration;

// DEADLINE는 test의 CPU 시간 한도이고, 멈춘 test를 끝내는 wall-clock 기한은 그 열 배다
// (orm_testcase::wall_for_cpu).
const DEADLINE: Duration = Duration::from_secs(10);

const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

fn text(lines: &Value) -> String {
    lines.as_array().unwrap().iter().map(|l| format!("{}\n", l.as_str().unwrap())).collect()
}

/// 줄을 LF로 잇는다. 줄이 없으면 빈 text다.
fn lines_text(lines: &Value) -> String {
    text(lines)
}

/// statement 가운데 CREATE TABLE이 만드는 table 이름이다.
fn created_tables(statements: &[String]) -> Vec<&str> {
    statements
        .iter()
        .filter_map(|s| s.strip_prefix("CREATE TABLE "))
        .map(|rest| rest.split(' ').next().unwrap_or("").trim_matches(|c| c == '`' || c == '"'))
        .collect()
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
    let path = orm_testcase::manifest_dir().join("../../../tests/dbspec/cases.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn located(errors: &[Diagnostic]) -> Vec<(String, usize, usize)> {
    errors.iter().map(|e| (e.rule.clone(), e.line, e.column)).collect()
}

#[test]
fn manifest_vectors() {
    let _case = orm_testcase::case!(orm_testcase::wall_for_cpu(DEADLINE));
    let clock = CaseClock::start();
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
        orm_testcase::step(format_args!("hashes/{id}"));
    }
    let (cpu, wall) = (clock.cpu(), clock.wall());
    assert!(cpu < DEADLINE, "dbspec manifest vectors exceeded {DEADLINE:?} (cpu {cpu:?}, wall {wall:?})");
    orm_testcase::step(format_args!("dbspec manifest vectors {} cases cpu={cpu:?} wall={wall:?}", hashes.len()));
}

#[test]
fn manifest_rejects_repeated_document_name() {
    let _case = orm_testcase::case!(orm_testcase::wall_for_cpu(DEADLINE));
    let clock = CaseClock::start();
    let source = "dbspec 1 shop\n\ntable users {\n  id i64 identity\n  primary key (id)\n}\n";
    let first = parsed("first", source, &BTreeMap::new());
    let second = parsed("second", source, &BTreeMap::new());
    let errors = dbspec::manifest(&[&first, &second]).expect_err("a set that repeats a document name has no manifest");
    let got: Vec<(&str, usize, usize)> = errors.iter().map(|e| (e.rule.as_str(), e.line, e.column)).collect();
    assert_eq!(got, vec![("name.duplicate", 1, 10)]);
    let (cpu, wall) = (clock.cpu(), clock.wall());
    assert!(cpu < DEADLINE, "cpu {cpu:?} exceeds {DEADLINE:?} (wall {wall:?})");
    orm_testcase::step(format_args!("dbspec manifest repeated name cpu={cpu:?} wall={wall:?}"));
}

#[test]
fn set_vectors() {
    let _case = orm_testcase::case!(orm_testcase::wall_for_cpu(DEADLINE));
    let clock = CaseClock::start();
    let cases = cases();
    let sets = cases["sets"].as_array().expect("sets cases");
    assert!(!sets.is_empty(), "tests/dbspec/cases.json has no sets cases");
    for case in sets {
        let id = case["id"].as_str().unwrap();
        // 각 문서는 다른 소유 문서, 외부 문서, parsing 문서를 집합으로 parse한다.
        let owned = case["documents"].as_array().unwrap().len();
        let texts: Vec<String> =
            case["documents"].as_array().unwrap().iter().chain(case.get("external").and_then(Value::as_array).into_iter().flatten()).map(text).collect();
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
                let mut document = parsed(id, source, &set);
                document.external = i >= owned;
                document
            })
            .collect();
        let refs: Vec<&Document> = documents.iter().collect();
        let want: Vec<(String, usize, usize)> = case["errors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (e["rule"].as_str().unwrap().to_owned(), e["line"].as_u64().unwrap() as usize, e["column"].as_u64().unwrap() as usize))
            .collect();
        let expected = case.get("manifest");
        match dbspec::manifest(&refs) {
            Ok(manifest) => {
                assert!(want.is_empty(), "{id}: manifest gave no errors, want {want:?}");
                if let Some(m) = expected {
                    assert_eq!(manifest.manifest_text, lines_text(&m["manifestText"]), "{id}: manifestText");
                    assert_eq!(manifest.external_text, lines_text(&m["externalText"]), "{id}: externalText");
                    assert_eq!(manifest.schema_text, lines_text(&m["schemaText"]), "{id}: schemaText");
                    assert_eq!(manifest.manifest_hash, m["manifestHash"].as_str().unwrap(), "{id}: manifestHash");
                    assert_eq!(manifest.schema_hash, m["schemaHash"].as_str().unwrap(), "{id}: schemaHash");
                }
            }
            Err(errors) => {
                assert!(!want.is_empty(), "{id}: manifest gave {errors:?}");
                assert_eq!(located(&errors), want, "{id}: manifest");
            }
        }
        for (dialect_name, dialect) in DIALECTS {
            match dbspec::render(&refs, dialect) {
                Ok(statements) => {
                    assert!(want.is_empty(), "{id}: {dialect_name} rendered, want {want:?}");
                    if let Some(m) = expected {
                        let created: Vec<&str> = m["created"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
                        assert_eq!(created_tables(&statements), created, "{id}: {dialect_name} created tables");
                    }
                }
                Err(errors) => {
                    assert!(!want.is_empty(), "{id}: {dialect_name} gave {errors:?}");
                    assert_eq!(located(&errors), want, "{id}: {dialect_name}");
                }
            }
        }
        orm_testcase::step(format_args!("sets/{id}"));
    }
    let (cpu, wall) = (clock.cpu(), clock.wall());
    assert!(cpu < DEADLINE, "dbspec set vectors exceeded {DEADLINE:?} (cpu {cpu:?}, wall {wall:?})");
    orm_testcase::step(format_args!("dbspec set vectors {} cases cpu={cpu:?} wall={wall:?}", sets.len()));
}
