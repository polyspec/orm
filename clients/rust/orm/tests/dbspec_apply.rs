//! Plan chains applied to MySQL, PostgreSQL and SQLite through
//! `orm::dbspec::apply` and `orm::dbspec::recover` (docs/plans.md, "Apply"):
//! the chain with its history and a second apply without events, drift, the
//! lock of a second session, rollback after a stopped statement, a failed
//! verification, and MySQL recovery after a stop before and after a
//! statement. The chain is create-from-empty and rename-table-and-column of
//! tests/dbspec/plans.json. A test fails when ORM_TEST_MYSQL_DSN or
//! ORM_TEST_POSTGRES_DSN is unset.

#[path = "common/dbspec_probe.rs"]
mod dbspec_probe;

use chrono::{DateTime, TimeZone, Utc};
use dbspec_probe::{connection_rules, lines, repository, run_probe, Conn, Servers, Session, DIALECTS};
use orm::dbspec::{self, apply, parse_plan, recover, ApplyConnection, ApplyError, ApplyEvent, ApplyEventKind, CatalogQuerier, CatalogValue, Dialect, Plan};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

type EventError = Box<dyn std::error::Error + Send + Sync>;

/// apply를 event 처리기에서 멈추는 error.
#[derive(Debug)]
struct Stop;

impl std::fmt::Display for Stop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("stop")
    }
}

impl std::error::Error for Stop {}

fn stopped(result: &Result<(), ApplyError>) -> bool {
    matches!(result, Err(ApplyError::Event(e)) if e.downcast_ref::<Stop>().is_some())
}

fn code(result: &Result<(), ApplyError>) -> Option<&'static str> {
    result.as_ref().err().and_then(ApplyError::code)
}

/// tests/dbspec/plans.json의 create-from-empty와 그 target에서 시작하는
/// rename-table-and-column.
fn apply_chain() -> Vec<Plan> {
    let path = repository().join("tests/dbspec/plans.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("plans.json")).expect("plans.json");
    let plans: Vec<Plan> = vectors["cases"]
        .as_array()
        .expect("plan cases")
        .iter()
        .filter(|c| matches!(c["id"].as_str(), Some("create-from-empty" | "rename-table-and-column")))
        .map(|c| parse_plan(&lines(&c["plan"])).unwrap_or_else(|e| panic!("{}: {e:?}", c["id"])))
        .collect();
    assert!(plans.len() == 2 && plans[1].from() == Some(plans[0].to()), "plans.json does not chain create-from-empty and rename-table-and-column");
    plans
}

fn fixed_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).single().expect("fixed time")
}

/// 지정한 statement를 실행한 직후 plan 밖의 table `sneak`을 같은 connection에서
/// 한 번 만든다. Go test가 마지막 statement의 `applied` event에서 만드는 것과 같은
/// 시점이다.
struct Sneak<'c, C> {
    inner: &'c mut C,
    after: String,
    done: bool,
}

impl<C: CatalogQuerier + Send> CatalogQuerier for Sneak<'_, C> {
    async fn rows(&mut self, query: &'static str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        self.inner.rows(query).await
    }
}

impl<C: ApplyConnection + Send> ApplyConnection for Sneak<'_, C> {
    async fn execute(&mut self, statement: &str) -> Result<(), sqlx::Error> {
        self.inner.execute(statement).await?;
        if !self.done && statement == self.after {
            self.done = true;
            self.inner.execute("CREATE TABLE sneak (id integer PRIMARY KEY)").await?;
        }
        Ok(())
    }

    async fn execute_bound(&mut self, statement: &str, args: &[CatalogValue]) -> Result<(), sqlx::Error> {
        self.inner.execute_bound(statement, args).await
    }

    async fn query_bound(&mut self, query: &str, args: &[CatalogValue]) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        self.inner.query_bound(query, args).await
    }
}

/// probe connection 하나에 apply 또는 recover를 실행한다. `sneak`이 있으면 그
/// statement 뒤에 `sneak` table을 만든다.
async fn run(
    conn: &mut Conn,
    recovering: bool,
    plans: &[Plan],
    sneak: Option<&str>,
    events: &mut (dyn FnMut(&ApplyEvent) -> Result<(), EventError> + Send),
) -> Result<(), ApplyError> {
    async fn on<C: ApplyConnection + Send>(
        c: &mut C,
        dialect: Dialect,
        recovering: bool,
        plans: &[Plan],
        sneak: Option<&str>,
        events: &mut (dyn FnMut(&ApplyEvent) -> Result<(), EventError> + Send),
    ) -> Result<(), ApplyError> {
        match sneak {
            Some(after) => {
                let mut wrapped = Sneak { inner: c, after: after.to_owned(), done: false };
                if recovering {
                    recover(&mut wrapped, dialect, plans, &fixed_now, events).await
                } else {
                    apply(&mut wrapped, dialect, plans, &fixed_now, events).await
                }
            }
            None if recovering => recover(c, dialect, plans, &fixed_now, events).await,
            None => apply(c, dialect, plans, &fixed_now, events).await,
        }
    }
    match conn {
        Conn::MySql(c) => on(c, Dialect::MySql, recovering, plans, sneak, events).await,
        Conn::Postgres(c) => on(c, Dialect::Postgres, recovering, plans, sneak, events).await,
        Conn::Sqlite(c) => on(c, Dialect::Sqlite, recovering, plans, sneak, events).await,
    }
}

fn quiet(_: &ApplyEvent) -> Result<(), EventError> {
    Ok(())
}

/// `query`의 유일한 값을 text로 읽는다.
async fn scalar(conn: &mut Conn, query: &str) -> Result<String, String> {
    let rows = match conn {
        Conn::MySql(c) => c.query_bound(query, &[]).await,
        Conn::Postgres(c) => c.query_bound(query, &[]).await,
        Conn::Sqlite(c) => c.query_bound(query, &[]).await,
    }
    .map_err(|e| format!("{query}: {e}"))?;
    match rows.as_slice() {
        [row] => match row.as_slice() {
            [CatalogValue::Int(n)] => Ok(n.to_string()),
            [CatalogValue::Text(s)] => Ok(s.clone()),
            other => Err(format!("{query}: the value {other:?} is not one integer or text")),
        },
        _ => Err(format!("{query}: {} rows; want one", rows.len())),
    }
}

async fn want(conn: &mut Conn, query: &str, expected: &str) -> Result<(), String> {
    let got = scalar(conn, query).await?;
    if got == expected {
        Ok(())
    } else {
        Err(format!("{query}: got {got:?}; want {expected:?}"))
    }
}

/// introspect한 schema text가 `expected`(빈 database이면 빈 문자열)인지 확인한다.
async fn schema_is(conn: &mut Conn, expected: &str) -> Result<(), String> {
    let (introspection, _) = conn.introspect().await.map_err(|e| format!("introspect: {e}"))?;
    if !introspection.unsupported.is_empty() {
        return Err(format!("unsupported: {:?}", introspection.unsupported));
    }
    let got = if !introspection.document.has_tables() {
        String::new()
    } else {
        dbspec::manifest(&[&introspection.document]).map_err(|e| format!("manifest: {e:?}"))?.schema_text
    };
    if got != expected {
        return Err(format!("schema text\n--- want\n{expected}--- got\n{got}"));
    }
    Ok(())
}

fn history(db: &str) -> &'static str {
    if db == "mysql" {
        "`dbspec$plans`"
    } else {
        "\"dbspec$plans\""
    }
}

async fn chain_history_and_again(conn: &mut Conn, db: &str, plans: &[Plan], target: &str) -> Result<(), String> {
    let mut counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut record = |e: &ApplyEvent| -> Result<(), EventError> {
        *counts.entry(e.kind.as_str()).or_default() += 1;
        Ok(())
    };
    run(conn, false, plans, None, &mut record).await.map_err(|e| format!("apply: {e}"))?;
    schema_is(conn, target).await?;
    want(conn, &format!("SELECT COUNT(*) FROM {} WHERE state = 'done'", history(db)), "2").await?;
    let count = |k: &str| counts.get(k).copied().unwrap_or(0);
    if count("plan") != 2 || count("verified") != 2 || count("done") != 2 || count("statement") != count("applied") || count("statement") == 0 {
        return Err(format!("events {counts:?}"));
    }
    let mut again = 0;
    let mut record_again = |_: &ApplyEvent| -> Result<(), EventError> {
        again += 1;
        Ok(())
    };
    let result = run(conn, false, plans, None, &mut record_again).await;
    if result.is_err() || again != 0 {
        return Err(format!("apply again: {result:?}, {again} events"));
    }
    Ok(())
}

async fn drift(conn: &mut Conn, plans: &[Plan]) -> Result<(), String> {
    run(conn, false, &plans[..1], None, &mut quiet).await.map_err(|e| format!("apply: {e}"))?;
    conn.exec("CREATE TABLE extra (id integer PRIMARY KEY)").await?;
    let result = run(conn, false, plans, None, &mut quiet).await;
    match code(&result) {
        Some("drift") => Ok(()),
        _ => Err(format!("apply after a change outside plans: {result:?}, want drift")),
    }
}

async fn lock(conn: &mut Conn, db: &str, plans: &[Plan], session: &Session) -> Result<(), String> {
    let mut other = session.open().await.map_err(|e| format!("session: {e}"))?;
    let hold = match db {
        "mysql" => "SELECT GET_LOCK('dbspec$plans', 0)",
        "postgres" => "SELECT pg_advisory_lock(hashtext('dbspec$plans'))",
        _ => "BEGIN IMMEDIATE",
    };
    let checked = async {
        other.exec(hold).await.map_err(|e| format!("hold: {e}"))?;
        let result = run(conn, false, plans, None, &mut quiet).await;
        if code(&result) != Some("locked") {
            return Err(format!("apply under another session's lock: {result:?}, want locked"));
        }
        if db == "sqlite" {
            other.exec("ROLLBACK").await?;
        }
        Ok(())
    }
    .await;
    let closed = other.close().await.map_err(|e| format!("close session: {e}"));
    checked.and(closed)
}

async fn rollback_on_failure(conn: &mut Conn, plans: &[Plan], target: &str) -> Result<(), String> {
    let mut fail = |e: &ApplyEvent| -> Result<(), EventError> {
        if e.kind == ApplyEventKind::Applied && e.step == 1 {
            return Err(Box::new(Stop));
        }
        Ok(())
    };
    let result = run(conn, false, plans, None, &mut fail).await;
    if !stopped(&result) {
        return Err(format!("apply stopped by an event: {result:?}"));
    }
    schema_is(conn, "").await?;
    run(conn, false, plans, None, &mut quiet).await.map_err(|e| format!("apply after the rollback: {e}"))?;
    schema_is(conn, target).await
}

async fn verify_failure(conn: &mut Conn, db: &str, plans: &[Plan]) -> Result<(), String> {
    // 첫 plan의 마지막 statement 뒤에 plan 밖의 table을 만들면 검증이 실패한다.
    let dialect = DIALECTS.iter().find(|(name, _)| *name == db).map(|(_, d)| *d).ok_or_else(|| format!("unknown database {db}"))?;
    let statements = dbspec::plan_statements(None, &plans[0], dialect).map_err(|e| format!("statements: {e:?}"))?;
    let last = statements.last().ok_or("the first plan has no statement")?;
    let result = run(conn, false, plans, Some(last), &mut quiet).await;
    if code(&result) != Some("verify") {
        return Err(format!("apply with a table outside the plan: {result:?}, want verify"));
    }
    if db == "mysql" {
        want(conn, "SELECT state FROM `dbspec$plans`", "running").await
    } else {
        schema_is(conn, "").await
    }
}

/// MySQL recovery: statement이 commit된 뒤 기록 전에 멈춘 경우(`applied`)와 실행
/// 전에 멈춘 경우(`statement`).
async fn recover_after(conn: &mut Conn, kind: ApplyEventKind, plans: &[Plan], target: &str) -> Result<(), String> {
    let name = plans[1].name().to_owned();
    let mut fail = |e: &ApplyEvent| -> Result<(), EventError> {
        if e.kind == kind && e.plan == name && e.step == 1 {
            return Err(Box::new(Stop));
        }
        Ok(())
    };
    let result = run(conn, false, plans, None, &mut fail).await;
    if !stopped(&result) {
        return Err(format!("apply stopped by an event: {result:?}"));
    }
    want(conn, &format!("SELECT CONCAT(state, ' ', step) FROM `dbspec$plans` WHERE name = '{}'", plans[1].name()), "running 1").await?;
    let result = run(conn, false, plans, None, &mut quiet).await;
    if code(&result) != Some("interrupted") {
        return Err(format!("apply over a running plan: {result:?}, want interrupted"));
    }
    run(conn, true, plans, None, &mut quiet).await.map_err(|e| format!("recover: {e}"))?;
    schema_is(conn, target).await?;
    want(conn, "SELECT COUNT(*) FROM `dbspec$plans` WHERE state = 'done'", "2").await?;
    run(conn, true, plans, None, &mut quiet).await.map_err(|e| format!("recover again: {e}"))
}

/// scenario 이름과 그 database.
const SCENARIOS: [(&str, &[&str]); 7] = [
    ("chain_history_and_again", &["mysql", "postgres", "sqlite"]),
    ("drift", &["mysql", "postgres", "sqlite"]),
    ("lock", &["mysql", "postgres", "sqlite"]),
    ("rollback_on_failure", &["postgres", "sqlite"]),
    ("verify_failure", &["mysql", "postgres", "sqlite"]),
    ("recover_after_applied", &["mysql"]),
    ("recover_after_statement", &["mysql"]),
];

#[tokio::test]
async fn apply_chain_on_three_databases() {
    let started = Instant::now();
    println!("RUN dbspec apply");
    let plans = apply_chain();
    let target = dbspec::manifest(&[plans[1].schema()]).expect("target manifest").schema_text;
    let mut servers = Servers::open("apply").await;
    let mut failures = Vec::new();
    let mut runs = 0;
    for (scenario, dbs) in SCENARIOS {
        for &db in dbs {
            runs += 1;
            let id = format!("{db}.apply.{scenario}");
            let session = servers.session(db, runs);
            // probe body는 'static future이므로 chain과 target을 복사해 가져간다.
            let (plans, target) = (plans.clone(), target.clone());
            let result = run_probe(&mut servers, &id, db, runs, |conn| {
                Box::pin(async move {
                    let (plans, target) = (plans.as_slice(), target.as_str());
                    conn.exec_all(&connection_rules(db).iter().map(|s| (*s).to_owned()).collect::<Vec<_>>()).await?;
                    match scenario {
                        "chain_history_and_again" => chain_history_and_again(conn, db, plans, target).await,
                        "drift" => drift(conn, plans).await,
                        "lock" => lock(conn, db, plans, &session).await,
                        "rollback_on_failure" => rollback_on_failure(conn, plans, target).await,
                        "verify_failure" => verify_failure(conn, db, plans).await,
                        "recover_after_applied" => recover_after(conn, ApplyEventKind::Applied, plans, target).await,
                        "recover_after_statement" => recover_after(conn, ApplyEventKind::Statement, plans, target).await,
                        other => Err(format!("unknown scenario {other}")),
                    }
                })
            })
            .await;
            if let Err(e) = result {
                failures.push(format!("{id}: {e}"));
            }
        }
    }
    servers.close().await;
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(runs, 16, "apply runs");
    println!("PASS dbspec apply: {runs} runs on three databases in {:?}", started.elapsed());
    assert!(started.elapsed() < Duration::from_secs(600), "apply exceeded 600s");
}
