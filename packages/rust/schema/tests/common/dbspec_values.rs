//! The values shared by the dbspec manifest and render tests.

use polyspec_orm_schema::dbspec::{self, Dialect, Document};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::Duration;

use crate::or_panic::OrPanic;

// DEADLINE is the CPU time limit of the test; the wall-clock deadline that ends a hung test is ten times that.
// (polyspec_orm_testcase::wall_for_cpu).
pub const DEADLINE: Duration = Duration::from_secs(10);

pub const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

pub fn text(lines: &Value) -> String {
    lines.as_array().unwrap().iter().map(|l| format!("{}\n", l.as_str().unwrap())).collect()
}

/// Parses the documents of a case, each with the other documents of the case as its set.
pub fn case_documents(id: &str, case: &Value) -> Vec<Document> {
    let documents_value = case["documents"].as_object().unwrap();
    documents_value
        .iter()
        .map(|(name, lines)| {
            let set: BTreeMap<String, String> = documents_value.iter().filter(|(other, _)| *other != name).map(|(other, l)| (other.clone(), text(l))).collect();
            dbspec::parse(&text(lines), &set).map(|parsed| parsed.document).or_panic(|errors| format!("{id}: {errors:?}"))
        })
        .collect()
}
