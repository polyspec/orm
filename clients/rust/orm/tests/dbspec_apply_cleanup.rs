//! The cleanup errors of `orm::dbspec::apply` (docs/plans.md, "Apply"): a
//! wrapped SQLite connection injects a failing lock release after an event
//! stops apply and a failing foreign key restore after a failing BEGIN
//! EXCLUSIVE, and a scripted MySQL connection returns no row for an effect
//! query. Apply must return every error: the first
//! failure alone, or `ApplyError::Cleanup` with the first failure and the
//! cleanup error.

use chrono::{DateTime, TimeZone, Utc};
use orm::dbspec::{
    apply, effect_holds, effect_query, parse_plan, ApplyConnection, ApplyError, ApplyEvent, ApplyEventKind, CatalogQuerier, CatalogValue, Dialect, Effect, Plan,
};
use serde_json::Value;
use sqlx::{Connection, SqliteConnection};
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::time::Duration;

type EventError = Box<dyn std::error::Error + Send + Sync>;

/// 한 case의 기한.
const CASE_DEADLINE: Duration = Duration::from_secs(20);

/// apply를 event 처리기에서 멈추는 error.
#[derive(Debug)]
struct Stop;

impl std::fmt::Display for Stop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("stop")
    }
}

impl std::error::Error for Stop {}

/// tests/dbspec/plans.json의 create-from-empty.
fn create_from_empty() -> Vec<Plan> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/dbspec/plans.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("plans.json")).expect("plans.json");
    let case = vectors["cases"].as_array().expect("plan cases").iter().find(|c| c["id"] == "create-from-empty").expect("create-from-empty case");
    let text: String = case["plan"].as_array().expect("plan lines").iter().map(|l| format!("{}\n", l.as_str().expect("plan line"))).collect();
    vec![parse_plan(&text).unwrap_or_else(|e| panic!("create-from-empty: {e:?}"))]
}

/// tool clock: 2026-10-01T00:00:00.123456789Z. history의 applied_at은 소수 여섯 자리로 버린다.
fn fixed_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).single().expect("fixed time") + chrono::Duration::nanoseconds(123_456_789)
}

fn quiet(_: &ApplyEvent) -> Result<(), EventError> {
    Ok(())
}

/// 실제 SQLite connection을 감싸서 `fail`의 statement를 실행하면 그 message의
/// error를 돌려준다.
struct Failing {
    inner: SqliteConnection,
    fail: HashMap<&'static str, &'static str>,
}

impl CatalogQuerier for Failing {
    async fn rows(&mut self, query: &'static str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
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

    async fn execute_bound(&mut self, statement: &str, args: &[CatalogValue]) -> Result<(), sqlx::Error> {
        self.inner.execute_bound(statement, args).await
    }

    async fn query_bound(&mut self, query: &str, args: &[CatalogValue]) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        self.inner.query_bound(query, args).await
    }
}

async fn failing(fail: &[(&'static str, &'static str)]) -> Result<Failing, String> {
    let inner = SqliteConnection::connect("sqlite::memory:").await.map_err(|e| format!("sqlite: {e}"))?;
    Ok(Failing { inner, fail: fail.iter().copied().collect() })
}

/// 읽는 query마다 정한 row를 돌려주는 MySQL connection. 정한 문장 밖의
/// 실행과 query는 error다.
struct Scripted {
    executes: Vec<String>,
    queries: HashMap<String, Vec<Vec<CatalogValue>>>,
}

impl CatalogQuerier for Scripted {
    async fn rows(&mut self, query: &'static str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
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

/// 정리에서 난 database error의 message.
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
    // sqlx는 SQLite foreign key를 켠 채 연다.
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

/// case 하나를 기한 안에서 실행하고 시작, 결과, 걸린 시간을 알린다.
async fn case<F: Future<Output = Result<String, String>>>(id: &str, body: F) -> Result<(), String> {
    let mut inner = orm_testcase::start(id, CASE_DEADLINE);
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

#[tokio::test]
async fn apply_reports_cleanup_errors() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    let plans = create_from_empty();
    let results = [
        case("apply/cleanup-errors/release", release(plans.clone())).await,
        case("apply/cleanup-errors/begin-restore", begin_restore(plans.clone())).await,
        case("apply/effect-row", effect_row()).await,
    ];
    let failures: Vec<&String> = results.iter().filter_map(|r| r.as_ref().err()).collect();
    assert!(failures.is_empty(), "{} of {} cases failed: {failures:?}", failures.len(), results.len());
}
