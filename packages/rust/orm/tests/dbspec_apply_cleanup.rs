//! The cleanup errors of `polyspec_orm::dbspec::apply` (docs/spec/plans.md, "Apply"): a
//! wrapped SQLite connection injects a failing lock release after an event
//! stops apply and a failing foreign key restore after a failing BEGIN
//! EXCLUSIVE, a rollback of an applied row whose recorded step lies outside
//! the plan stops with a chain error, and a scripted MySQL connection returns
//! no row for an effect query. Apply must return every error: the first
//! failure alone, or `ApplyError::Cleanup` with the first failure and the
//! cleanup error.

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;
#[macro_use]
#[path = "common/dbspec_apply_support.rs"]
mod dbspec_apply_support;

use dbspec_apply_support::{fixed_now, quiet, EventError, Stop};
use polyspec_orm::dbspec::{
    apply, effect_holds, effect_query, parse_plan, rollback, ApplyConnection, ApplyError, ApplyEvent, ApplyEventKind, CatalogQuerier, CatalogValue, Dialect,
    Effect, Plan,
};
use serde_json::Value;
use sqlx::{Connection, SqliteConnection};
use std::collections::HashMap;
use std::future::Future;
use std::time::Duration;

/// The deadline of one case.
const CASE_DEADLINE: Duration = Duration::from_secs(20);

/// create-from-empty from tests/dbspec/plans.json.
fn create_from_empty() -> Vec<Plan> {
    let path = polyspec_orm_testcase::manifest_dir().join("../../../tests/dbspec/plans.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("plans.json")).expect("plans.json");
    let case = vectors["cases"].as_array().expect("plan cases").iter().find(|c| c["id"] == "create-from-empty").expect("create-from-empty case");
    let text: String = case["plan"].as_array().expect("plan lines").iter().map(|l| format!("{}\n", l.as_str().expect("plan line"))).collect();
    vec![parse_plan(&text).or_panic(|e| format!("create-from-empty: {e:?}"))]
}


/// Wraps a real SQLite connection so that when the `fail` statement runs, its message
/// is returned as the error.
struct Failing {
    inner: SqliteConnection,
    fail: HashMap<&'static str, &'static str>,
    catalog_failure: Option<&'static str>,
    catalog_failure_call: usize,
    catalog_reads: usize,
}

impl CatalogQuerier for Failing {
    async fn rows(&mut self, query: &str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        if query.starts_with("SELECT type, name, tbl_name") {
            self.catalog_reads += 1;
            if let Some(message) = self.catalog_failure {
                if self.catalog_reads == self.catalog_failure_call {
                    return Err(sqlx::Error::Protocol(message.to_owned()));
                }
            }
        }
        self.inner.rows(query).await
    }
}

impl ApplyConnection for Failing {
    async fn execute(&mut self, statement: &str) -> Result<(), sqlx::Error> {
        match self.fail.get(statement) {
            Some(message) => Err(sqlx::Error::Protocol((*message).to_owned())),
            None => self.inner.execute(statement).await,
        }
    }

    delegate_bound_methods!();
}

async fn failing(fail: &[(&'static str, &'static str)]) -> Result<Failing, String> {
    let inner = SqliteConnection::connect("sqlite::memory:").await.map_err(|e| format!("sqlite: {e}"))?;
    Ok(Failing { inner, fail: fail.iter().copied().collect(), catalog_failure: None, catalog_failure_call: 1, catalog_reads: 0 })
}

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

/// The message of a database error raised in cleanup.
fn cleanup_message(e: &ApplyError) -> Option<&str> {
    match e {
        ApplyError::Database(e) => protocol_message(e),
        _ => None,
    }
}

async fn release(plans: Vec<Plan>) -> Result<String, String> {
    let mut c = failing(&[("PRAGMA locking_mode = normal", "release failed")]).await?;
    let mut stop = |e: &ApplyEvent| -> Result<(), EventError> {
        if e.kind == ApplyEventKind::Applied {
            return Err(Box::new(Stop));
        }
        Ok(())
    };
    let result = apply(&mut c, Dialect::Sqlite, &plans, &fixed_now, &mut stop).await;
    match &result {
        Err(ApplyError::Cleanup { error, cleanup })
            if matches!(error.as_ref(), ApplyError::Event(e) if e.downcast_ref::<Stop>().is_some()) && cleanup_message(cleanup) == Some("release failed") =>
        {
            Ok(result.err().map(|e| e.to_string()).unwrap_or_default())
        }
        _ => Err(format!("{result:?}; want the stop with the release error")),
    }
}

async fn begin_restore(plans: Vec<Plan>) -> Result<String, String> {
    // sqlx opens with SQLite foreign keys turned on.
    let mut c = failing(&[("BEGIN EXCLUSIVE", "begin failed"), ("PRAGMA foreign_keys = 1", "restore failed")]).await?;
    let result = apply(&mut c, Dialect::Sqlite, &plans, &fixed_now, &mut quiet).await;
    match &result {
        Err(ApplyError::Cleanup { error, cleanup })
            if matches!(error.as_ref(), ApplyError::Locked { source: Some(e), .. } if protocol_message(e) == Some("begin failed"))
                && cleanup_message(cleanup) == Some("restore failed") =>
        {
            Ok(result.err().map(|e| e.to_string()).unwrap_or_default())
        }
        _ => Err(format!("{result:?}; want locked with the restore error")),
    }
}

async fn rollback_step_outside(plans: Vec<Plan>) -> Result<String, String> {
    let mut c = failing(&[]).await?;
    apply(&mut c, Dialect::Sqlite, &plans, &fixed_now, &mut quiet).await.map_err(|e| format!("apply: {e}"))?;
    c.execute(r#"UPDATE "dbspec$plans" SET step = 99"#).await.map_err(|e| format!("update: {e}"))?;
    let result = rollback(&mut c, Dialect::Sqlite, &plans, &fixed_now, &mut quiet).await;
    match &result {
        Err(ApplyError::Chain { message, .. }) if message == "the recorded step 99 is outside the plan's 4 steps" => Ok(message.clone()),
        _ => Err(format!("{result:?}; want a chain error about the recorded step")),
    }
}

async fn settled_introspection_error(plans: Vec<Plan>) -> Result<String, String> {
    let mut c = failing(&[]).await?;
    c.catalog_failure = Some("catalog read failed");
    verify_catalog_query_error(apply(&mut c, Dialect::Sqlite, &plans, &fixed_now, &mut quiet).await, "catalog read failed")
}

fn verify_catalog_query_error(result: Result<(), ApplyError>, expected: &str) -> Result<String, String> {
    match result {
        Err(ApplyError::Verify { source: Some(polyspec_orm::dbspec::IntrospectError::Query(sqlx::Error::Protocol(message))), .. }) if message == expected => {
            Ok("verify preserves the catalog driver error".to_owned())
        }
        result => Err(format!("{result:?}; want verify with the original catalog driver error")),
    }
}

async fn settled_schema_drift(plans: Vec<Plan>) -> Result<String, String> {
    let mut c = failing(&[]).await?;
    c.execute("CREATE TABLE unrelated (id INTEGER)").await.map_err(|e| format!("create unrelated table: {e}"))?;
    match apply(&mut c, Dialect::Sqlite, &plans, &fixed_now, &mut quiet).await {
        Err(ApplyError::Drift { message }) => Ok(message),
        result => Err(format!("{result:?}; want drift for a real schema mismatch")),
    }
}

async fn rollback_introspection_error(plans: Vec<Plan>) -> Result<String, String> {
    let mut c = failing(&[]).await?;
    apply(&mut c, Dialect::Sqlite, &plans, &fixed_now, &mut quiet).await.map_err(|e| format!("apply: {e}"))?;
    c.catalog_failure = Some("catalog read failed");
    c.catalog_failure_call = c.catalog_reads + 1;
    verify_catalog_query_error(rollback(&mut c, Dialect::Sqlite, &plans, &fixed_now, &mut quiet).await, "catalog read failed")
}

async fn post_forward_introspection_error(plans: Vec<Plan>) -> Result<String, String> {
    let mut c = failing(&[]).await?;
    c.catalog_failure = Some("post-forward catalog read failed");
    c.catalog_failure_call = 2;
    let mut kinds = Vec::new();
    let mut events = |event: &ApplyEvent| {
        kinds.push(event.kind.as_str().to_owned());
        Ok(())
    };
    let verify_message = match apply(&mut c, Dialect::Sqlite, &plans, &fixed_now, &mut events).await {
        Err(ApplyError::Verify { source: Some(polyspec_orm::dbspec::IntrospectError::Query(sqlx::Error::Protocol(message))), .. })
            if message == "post-forward catalog read failed" =>
        {
            message
        }
        result => return Err(format!("{result:?}; want verify with the original post-forward catalog error")),
    };
    let history = c.query_bound("SELECT state FROM \"dbspec$plans\"", &[]).await.map_err(|e| format!("read history: {e}"))?;
    let state = match history.first().and_then(|row| row.first()) {
        Some(CatalogValue::Text(state)) => state,
        value => return Err(format!("history state row is {value:?}; want applying")),
    };
    if state != "applying" || kinds.iter().any(|kind| kind == "verified" || kind == "done") {
        return Err(format!("failed post-forward verify reported success: state={state}, events={kinds:?}"));
    }
    Ok(format!("post-forward failure preserves {verify_message:?}, applying history, and no success events"))
}

fn assert_cases<T>(results: &[Result<T, String>]) {
    let failures: Vec<&String> = results.iter().filter_map(|result| result.as_ref().err()).collect();
    assert!(failures.is_empty(), "{} of {} cases failed: {failures:?}", failures.len(), results.len());
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

/// Runs one case within its deadline and reports the start, result, and elapsed time.
async fn case<F: Future<Output = Result<String, String>>>(id: &str, body: F) -> Result<(), String> {
    let mut inner = polyspec_orm_testcase::start(id, CASE_DEADLINE);
    let result = match tokio::time::timeout(CASE_DEADLINE, body).await {
        Ok(result) => result,
        Err(_) => Err(format!("deadline of {CASE_DEADLINE:?} exceeded")),
    };
    match &result {
        Ok(message) => inner.step(message),
        Err(e) => inner.fail(e),
    }
    drop(inner);
    result.map(drop).map_err(|e| format!("{id}: {e}"))
}

// Requirements: PLN-100.
#[tokio::test]
async fn apply_reports_cleanup_errors() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let plans = create_from_empty();
    let results = [
        case("apply/cleanup-errors/release", release(plans.clone())).await,
        case("apply/cleanup-errors/begin-restore", begin_restore(plans.clone())).await,
        case("apply/rollback-step-outside", rollback_step_outside(plans.clone())).await,
        case("apply/effect-row", effect_row()).await,
    ];
    assert_cases(&results);
}

// Requirements: PLN-92, PLN-93, PLN-96.
#[tokio::test]
async fn apply_reports_verify_errors_separately_from_drift() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let plans = create_from_empty();
    let results = [
        case("apply/settled-introspection-error", settled_introspection_error(plans.clone())).await,
        case("apply/settled-schema-drift", settled_schema_drift(plans.clone())).await,
        case("apply/rollback-introspection-error", rollback_introspection_error(plans.clone())).await,
        case("apply/post-forward-introspection-error", post_forward_introspection_error(plans)).await,
    ];
    assert_cases(&results);
}
