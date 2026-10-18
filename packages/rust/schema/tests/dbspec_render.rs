//! The vectors of tests/dbspec/ddl.json through `dbspec::render`: every case
//! renders the statements listed for MySQL, PostgreSQL and SQLite.

use polyspec_orm_schema::dbspec::{self, Dialect, Document};
use polyspec_orm_testcase::Trial;
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::Duration;

// DEADLINE is the CPU time limit of the test; the wall-clock deadline that ends a hung test is ten times that.
// (polyspec_orm_testcase::wall_for_cpu).
const DEADLINE: Duration = Duration::from_secs(10);

const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

fn text(lines: &Value) -> String {
    lines.as_array().unwrap().iter().map(|l| format!("{}\n", l.as_str().unwrap())).collect()
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_owned()).collect()
}

fn render_vectors() -> Vec<Trial> {
    let path = polyspec_orm_testcase::manifest_dir().join("../../../tests/dbspec/ddl.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = vectors["cases"].as_array().expect("ddl cases");
    assert!(!cases.is_empty(), "tests/dbspec/ddl.json has no cases");
    let mut trials = Vec::new();
    for case in cases {
        let id = case["id"].as_str().unwrap().to_owned();
        let case = case.clone();
        trials.push(polyspec_orm_testcase::trial(format!("render_vectors::{id}"), polyspec_orm_testcase::wall_for_cpu(DEADLINE), move || {
            render_vectors_case(&case)
        }));
    }
    trials
}

fn render_vectors_case(case: &Value) {
    let id = case["id"].as_str().unwrap();
    let documents_value = case["documents"].as_object().unwrap();
    let documents: Vec<Document> = documents_value
        .iter()
        .map(|(name, lines)| {
            let set: BTreeMap<String, String> = documents_value.iter().filter(|(other, _)| *other != name).map(|(other, l)| (other.clone(), text(l))).collect();
            dbspec::parse(&text(lines), &set).map(|parsed| parsed.document).unwrap_or_else(|errors| panic!("{id}: {errors:?}"))
        })
        .collect();
    let mut refs: Vec<&Document> = documents.iter().collect();
    for (dialect_name, dialect) in DIALECTS {
        let want = strings(&case["statements"][dialect_name]);
        assert_eq!(dbspec::render(&refs, dialect), Ok(want.clone()), "{id}: {dialect_name}");
        // The documents are rendered in use order, not in the order given.
        refs.reverse();
        assert_eq!(dbspec::render(&refs, dialect), Ok(want.clone()), "{id}: {dialect_name} reversed");
        polyspec_orm_testcase::step(format_args!("ddl/{id}/{dialect_name}"));
    }
}

fn main() {
    polyspec_orm_testcase::run(render_vectors());
}
