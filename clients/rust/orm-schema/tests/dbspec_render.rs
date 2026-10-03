//! The vectors of tests/dbspec/ddl.json through `dbspec::render`: every case
//! renders the statements listed for MySQL, PostgreSQL and SQLite.

use orm_case_clock::CaseClock;
use orm_schema::dbspec::{self, Dialect, Document};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

// DEADLINE는 test의 CPU 시간 한도이고, 멈춘 test를 끝내는 wall-clock 기한은 그 열 배다
// (orm_testcase::wall_for_cpu).
const DEADLINE: Duration = Duration::from_secs(10);

const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

fn text(lines: &Value) -> String {
    lines.as_array().unwrap().iter().map(|l| format!("{}\n", l.as_str().unwrap())).collect()
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_owned()).collect()
}

#[test]
fn render_vectors() {
    let _case = orm_testcase::case!(orm_testcase::wall_for_cpu(DEADLINE));
    let clock = CaseClock::start();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/dbspec/ddl.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = vectors["cases"].as_array().expect("ddl cases");
    assert!(!cases.is_empty(), "tests/dbspec/ddl.json has no cases");
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let documents_value = case["documents"].as_object().unwrap();
        let documents: Vec<Document> = documents_value
            .iter()
            .map(|(name, lines)| {
                let set: BTreeMap<String, String> =
                    documents_value.iter().filter(|(other, _)| *other != name).map(|(other, l)| (other.clone(), text(l))).collect();
                dbspec::parse(&text(lines), &set).unwrap_or_else(|errors| panic!("{id}: {errors:?}"))
            })
            .collect();
        let mut refs: Vec<&Document> = documents.iter().collect();
        for (dialect_name, dialect) in DIALECTS {
            let want = strings(&case["statements"][dialect_name]);
            assert_eq!(dbspec::render(&refs, dialect), Ok(want.clone()), "{id}: {dialect_name}");
            // The documents are rendered in use order, not in the order given.
            refs.reverse();
            assert_eq!(dbspec::render(&refs, dialect), Ok(want.clone()), "{id}: {dialect_name} reversed");
            orm_testcase::step(format_args!("ddl/{id}/{dialect_name}"));
        }
    }
    let (cpu, wall) = (clock.cpu(), clock.wall());
    assert!(cpu < DEADLINE, "dbspec render vectors exceeded {DEADLINE:?} (cpu {cpu:?}, wall {wall:?})");
    orm_testcase::step(format_args!("dbspec render vectors {} cases cpu={cpu:?} wall={wall:?}", cases.len()));
}
