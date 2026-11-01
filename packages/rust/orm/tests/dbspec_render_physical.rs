//! Physical run of the rendered statements of tests/dbspec/ddl.json (its "behavior" steps): every case with
//! behavior steps is rendered for MySQL, PostgreSQL and SQLite, applied to an empty database of that dialect,
//! and its steps run: a statement that must succeed or, with `fails`, must fail, and a query whose first value
//! equals `want`. A test fails when ORM_TEST_MYSQL_SERVER_DSN or ORM_TEST_POSTGRES_SERVER_DSN is unset.
//! Requirement: DIA-113 (check-recipes CR16-1-2).

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

#[path = "common/dbspec_probe.rs"]
mod dbspec_probe;

use dbspec_probe::{connection_rules, lines, parse_set, run_probe, Servers, DIALECTS};
use polyspec_orm_schema::dbspec::{self, Document};
use serde_json::Value;
use std::collections::BTreeMap;

/// The cases of tests/dbspec/ddl.json that have behavior steps, with their documents and steps.
fn behavior_cases() -> Vec<(String, BTreeMap<String, String>, Vec<Value>)> {
    let path = dbspec_probe::repository().join("tests/dbspec/ddl.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("ddl.json")).expect("ddl.json");
    vectors["cases"]
        .as_array()
        .expect("ddl cases")
        .iter()
        .filter(|case| case["behavior"].as_array().is_some_and(|steps| !steps.is_empty()))
        .map(|case| {
            let id = case["id"].as_str().expect("id").to_owned();
            let documents = case["documents"].as_object().expect("documents").iter().map(|(name, l)| (name.clone(), lines(l))).collect();
            let steps = case["behavior"].as_array().expect("behavior").clone();
            (id, documents, steps)
        })
        .collect()
}

// Requirement: DIA-113.
async fn render_physical() {
    let mut servers = Servers::open("render").await;
    let cases = behavior_cases();
    assert!(!cases.is_empty(), "tests/dbspec/ddl.json has no case with behavior steps");
    let mut index = 0;
    for (case_id, documents, steps) in &cases {
        let parsed = parse_set(case_id, documents);
        let refs: Vec<&Document> = parsed.iter().collect();
        for (db, dialect) in DIALECTS {
            let statements = dbspec::render(&refs, dialect).or_panic(|e| format!("{case_id} {db}: {e:?}"));
            let id = format!("{db}.render.{case_id}");
            index += 1;
            let steps = steps.clone();
            let result = run_probe(&mut servers, &id, db, index, |conn| {
                Box::pin(async move {
                    conn.exec_all(&connection_rules(db).iter().map(|s| (*s).to_owned()).collect::<Vec<_>>()).await?;
                    conn.exec_all(&statements).await?;
                    for step in &steps {
                        if let Some(only) = step["dialects"].as_array() {
                            if !only.iter().any(|d| d.as_str() == Some(db)) {
                                continue;
                            }
                        }
                        if let Some(sql) = step["sql"].as_str() {
                            let result = conn.exec_all(&[sql.to_owned()]).await;
                            if step["fails"].as_bool() == Some(true) {
                                if result.is_ok() {
                                    return Err(format!("{sql} must fail"));
                                }
                            } else {
                                result?;
                            }
                            continue;
                        }
                        let query = step["query"].as_str().expect("query or sql");
                        let want = step["want"].as_str().expect("want");
                        let got = conn.text_value(query).await?;
                        if got != want {
                            return Err(format!("{query}: want {want:?}, got {got:?}"));
                        }
                    }
                    Ok(())
                })
            })
            .await;
            if let Err(e) = result {
                servers.close().await;
                panic!("{id}: {e}");
            }
        }
    }
    servers.close().await;
}

fn main() {
    let trials = vec![polyspec_orm_testcase::async_trial("render_physical", polyspec_orm_testcase::DATABASE, render_physical)];
    polyspec_orm_testcase::run_in_order(trials);
}
