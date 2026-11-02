#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

use polyspec_orm_schema::dbspec;
use polyspec_orm_testcase::Trial;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

#[path = "common/dbspec_cases.rs"]
mod dbspec_cases;

const CASE_DEADLINE: Duration = Duration::from_secs(1);
// SUITE_DEADLINE is the CPU time limit of the test; the wall-clock deadline that ends a hung test is ten times that.
// (polyspec_orm_testcase::wall_for_cpu).
const SUITE_DEADLINE: Duration = Duration::from_secs(5);

fn cases_path() -> PathBuf {
    polyspec_orm_testcase::manifest_dir().join("../../../tests/dbspec/cases.json")
}

/// tests/dbspec/cases.json, read strictly: a missing or unknown section or field of any section panics with its place.
fn read_cases() -> Value {
    let path = cases_path();
    let value = serde_json::from_slice(&std::fs::read(&path).or_panic(|e| format!("{}: {e}", path.display()))).unwrap();
    dbspec_cases::check_cases(&value, "tests/dbspec/cases.json").or_panic(|e| e.to_string());
    value
}

/// The lines of a case joined with LF and a final LF, as the sets and hashes documents are written.
fn joined(lines: &Value) -> String {
    lines.as_array().unwrap().iter().map(|line| format!("{}\n", line.as_str().unwrap())).collect()
}

fn assert_keys(value: &Value, keys: &[&str], id: &str) {
    let object = value.as_object().unwrap_or_else(|| panic!("{id}: an object is expected"));
    for key in object.keys() {
        assert!(keys.contains(&key.as_str()), "{id}: unknown key {key}");
    }
    for key in keys {
        assert!(object.contains_key(*key), "{id}: missing key {key}");
    }
}

/// The analyses of tests/dbspec/syntax.json, built as scripts/dbspec/syntax-vectors.mts builds them (`vectorInputs`): each
/// document of a sets case with its 1-based place as the id suffix, with the parsing documents and the other documents of
/// the case; each document of a hashes case by its name. The document cases (canonical, normalize, invalid, positions,
/// files and set-parse) run from their recipes, whose analyze steps give their tokens.
fn vector_inputs(cases: &Value) -> Vec<(String, String, BTreeMap<String, String>)> {
    let mut inputs = Vec::new();
    for case in cases["sets"].as_array().expect("sets cases are listed") {
        let id = case["id"].as_str().unwrap();
        let documents = case["documents"].as_array().unwrap();
        let external: Vec<&Value> = case.get("external").and_then(Value::as_array).map_or(Vec::new(), |list| list.iter().collect());
        let all: Vec<&Value> = documents.iter().chain(external.iter().copied()).collect();
        for (index, lines) in documents.iter().enumerate() {
            let mut set = BTreeMap::new();
            for (name, other) in case["parsing"].as_object().unwrap() {
                set.insert(name.clone(), joined(other));
            }
            for (other_index, other) in all.iter().enumerate() {
                if other_index != index {
                    let text = joined(other);
                    let name = dbspec::parse_set(&[&text], &[]).remove(0).name.expect("a set document has a header name");
                    set.insert(name, text);
                }
            }
            inputs.push((format!("sets.{id}.{}", index + 1), joined(lines), set));
        }
    }
    for case in cases["hashes"].as_array().expect("hashes cases are listed") {
        let id = case["id"].as_str().unwrap();
        let documents = case["documents"].as_object().unwrap();
        for (name, lines) in documents {
            let mut set = BTreeMap::new();
            for (other, other_lines) in documents {
                if other != name {
                    set.insert(other.clone(), joined(other_lines));
                }
            }
            inputs.push((format!("hashes.{id}.{name}"), joined(lines), set));
        }
    }
    inputs
}

/// tests/dbspec/syntax.json, read strictly: an unknown or missing key panics.
fn syntax_file() -> Value {
    let path = polyspec_orm_testcase::manifest_dir().join("../../../tests/dbspec/syntax.json");
    let file: Value = serde_json::from_slice(&std::fs::read(&path).or_panic(|e| format!("{}: {e}", path.display()))).unwrap();
    assert_keys(&file, &["requirements", "version", "note", "cases"], "syntax.json");
    assert_eq!(file["version"].as_u64(), Some(1));
    file
}

/// syntax.json has exactly one entry for each analysis that cases.json gives; the file's key order is not compared.
fn syntax_entries_match_the_analyses() {
    let entries = syntax_file()["cases"].as_array().expect("syntax cases are listed").clone();
    let inputs = vector_inputs(&read_cases());
    let mut by_id = BTreeMap::new();
    for entry in &entries {
        assert_keys(entry, &["id", "tokens"], "syntax entry");
        let id = entry["id"].as_str().expect("entry id is a string").to_owned();
        assert!(by_id.insert(id.clone(), entry).is_none(), "{id}: syntax.json lists the id once");
    }
    assert_eq!(by_id.len(), inputs.len(), "syntax.json has one entry per analysis");
    for (id, _, _) in &inputs {
        assert!(by_id.contains_key(id), "{id}: syntax.json lists the analysis");
    }
}

/// Each entry of tests/dbspec/syntax.json, the trial `shared_dbspec_syntax::<id>`: its analysis equals its tokens
/// exactly. A token that is not four values panics.
// Requirements: ORES-1.
fn shared_dbspec_syntax(cases: &Value) -> Vec<Trial> {
    let mut inputs: BTreeMap<String, (String, BTreeMap<String, String>)> = BTreeMap::new();
    for (id, text, set) in vector_inputs(cases) {
        inputs.insert(id, (text, set));
    }
    let mut trials = Vec::new();
    for entry in syntax_file()["cases"].as_array().expect("syntax cases are listed") {
        let id = entry["id"].as_str().expect("entry id is a string").to_owned();
        let entry = entry.clone();
        let input = inputs.get(&id).cloned();
        trials.push(polyspec_orm_testcase::trial(format!("shared_dbspec_syntax::{id}"), polyspec_orm_testcase::wall_for_cpu(CASE_DEADLINE), move || {
            assert_keys(&entry, &["id", "tokens"], "syntax entry");
            let (text, set) = input.unwrap_or_else(|| panic!("{id}: cases.json gives the analysis"));
            let expected: Vec<(usize, usize, usize, String)> = entry["tokens"]
                .as_array()
                .unwrap()
                .iter()
                .map(|token| {
                    let values = token.as_array().unwrap_or_else(|| panic!("{id}: token is an array"));
                    assert_eq!(values.len(), 4, "{id}: token has four values");
                    (
                        values[0].as_u64().unwrap() as usize,
                        values[1].as_u64().unwrap() as usize,
                        values[2].as_u64().unwrap() as usize,
                        values[3].as_str().unwrap().to_owned(),
                    )
                })
                .collect();
            let got: Vec<(usize, usize, usize, String)> = dbspec::analyze(&text, &set).tokens.into_iter().map(|t| (t.line, t.start, t.end, t.class)).collect();
            assert_eq!(got, expected, "{id}: tokens");
        }));
    }
    trials
}

/// A change to cases.json, with the location and the problem that the reader names for it.
type Mutation<'a> = (&'a str, &'a str, Box<dyn Fn(&mut Value)>);

/// The reader of cases.json refuses a missing or an unknown section or field of the sections it keeps, naming it.
fn shared_dbspec_cases_reader_refuses_missing_and_unknown_fields() {
    let original = read_cases();
    let manifest = original["sets"].as_array().unwrap().iter().position(|c| c.get("manifest").is_some()).expect("a sets case has a manifest");
    let manifest_extra = format!("sets[{manifest}].manifest.extra");
    let mutations: Vec<Mutation> = vec![
        ("note", "is missing", Box::new(|v| drop(v.as_object_mut().unwrap().remove("note")))),
        ("extra", "is not a known field", Box::new(|v| v["extra"] = Value::Array(Vec::new()))),
        ("canonical", "is not a known field", Box::new(|v| v["canonical"] = Value::Array(Vec::new()))),
        ("hashes[0].extra", "is not a known field", Box::new(|v| v["hashes"][0]["extra"] = Value::Bool(true))),
        ("sets[0].extra", "is not a known field", Box::new(|v| v["sets"][0]["extra"] = Value::Bool(true))),
        (&manifest_extra, "is not a known field", Box::new(move |v| v["sets"][manifest]["manifest"]["extra"] = Value::Array(Vec::new()))),
    ];
    for (location, problem, change) in &mutations {
        let mut value = original.clone();
        change(&mut value);
        assert_eq!(dbspec_cases::check_cases(&value, "tests/dbspec/cases.json"), Err(format!("tests/dbspec/cases.json: {location} {problem}")), "{location}");
    }
    polyspec_orm_testcase::step(format_args!("{} refused", mutations.len()));
}

fn main() {
    let file = read_cases();
    let mut trials = shared_dbspec_syntax(&file);
    trials.push(polyspec_orm_testcase::trial(
        "syntax_entries_match_the_analyses",
        polyspec_orm_testcase::wall_for_cpu(SUITE_DEADLINE),
        syntax_entries_match_the_analyses,
    ));
    trials.push(polyspec_orm_testcase::trial(
        "shared_dbspec_cases_reader_refuses_missing_and_unknown_fields",
        polyspec_orm_testcase::wall_for_cpu(SUITE_DEADLINE),
        shared_dbspec_cases_reader_refuses_missing_and_unknown_fields,
    ));
    polyspec_orm_testcase::run(trials);
}
