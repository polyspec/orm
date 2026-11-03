//! The effect query of `polyspec_orm::dbspec` apply of Rust (docs/spec/plans.md, "Apply"): a scripted MySQL connection
//! returns no row for an effect query, whose row count message is the form of Rust. The cleanup errors are cases of the
//! recipe tests/dbspec/apply-verification-errors.json.

use polyspec_orm::dbspec::{effect_holds, effect_query, ApplyConnection, CatalogQuerier, CatalogValue, Dialect, Effect};
use std::collections::HashMap;

/// A MySQL connection that returns the set rows for each query it reads. Statements outside the set
/// executions and queries are errors.
struct Scripted {
    executes: Vec<String>,
    queries: HashMap<String, Vec<Vec<CatalogValue>>>,
}

impl CatalogQuerier for Scripted {
    async fn rows(&mut self, query: &str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        Err(sqlx::Error::Protocol(format!("unexpected catalog query {query}")))
    }
}

impl ApplyConnection for Scripted {
    async fn execute(&mut self, statement: &str) -> Result<(), sqlx::Error> {
        if self.executes.iter().any(|s| statement.starts_with(s.as_str())) {
            Ok(())
        } else {
            Err(sqlx::Error::Protocol(format!("unexpected statement {statement}")))
        }
    }

    async fn execute_bound(&mut self, statement: &str, _: &[CatalogValue]) -> Result<(), sqlx::Error> {
        Err(sqlx::Error::Protocol(format!("unexpected statement {statement}")))
    }

    async fn query_bound(&mut self, query: &str, _: &[CatalogValue]) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        self.queries.get(query).cloned().ok_or_else(|| sqlx::Error::Protocol(format!("unexpected query {query}")))
    }
}

fn protocol_message(e: &sqlx::Error) -> Option<&str> {
    match e {
        sqlx::Error::Protocol(m) => Some(m),
        _ => None,
    }
}

async fn effect_row() -> Result<String, String> {
    let tables = effect_query(Dialect::MySql, "table").ok_or("no MySQL table effect query")?;
    let mut c = Scripted { executes: vec![], queries: HashMap::from([(tables.to_owned(), vec![])]) };
    let effect = Effect { kind: "table", table: "orders".to_owned(), name: String::new(), present: true };
    let result = effect_holds(&mut c, Dialect::MySql, &effect).await;
    let want = format!("{tables} returned 0 rows; want one");
    match &result {
        Err(e) if protocol_message(e) == Some(want.as_str()) => Ok(want),
        _ => Err(format!("{result:?}; want {want:?}")),
    }
}

#[tokio::test]
async fn effect_query_without_a_row_fails() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    effect_row().await.expect("apply/effect-row");
}
