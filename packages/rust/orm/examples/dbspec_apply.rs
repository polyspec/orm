//! Applies the chain from plans.json (tests/dbspec/plans.json) (create-from-empty and
//! rename-table-and-column) to one database with the Rust client
//! (docs/spec/plans.md "Apply"). The action is apply-first (first plan only), apply (whole chain),
//! stop (halts after statement 1 of the second plan runs), recover (continues an interrupted plan
//! to the end), rollback (reverts the last plan in history). One result line goes to stdout: "ok", "stopped", or
//! "error <code>". Any other error is written to stderr and the process exits with 1.
//!
//! Usage: dbspec_apply <apply-first|apply|stop|recover|rollback|lock-wait> <mysql|postgres|sqlite> <uri> <plans.json>

use chrono::{DateTime, TimeZone, Utc};
use polyspec_orm::dbspec::{
    apply, parse_plan, recover, rollback, ApplyConnection, ApplyError, ApplyEvent, ApplyEventKind, CatalogQuerier, CatalogValue, Dialect, Plan,
};
use serde_json::Value;
use sqlx::Connection;

#[path = "../tests/common/apply_stop.rs"]
mod apply_stop;

use apply_stop::{record_steps, EventError, Stop};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [action, dialect, uri, vectors] = args.as_slice() else {
        eprintln!("usage: dbspec_apply <apply-first|apply|stop|recover|rollback> <mysql|postgres|sqlite> <uri> <plans.json>");
        std::process::exit(2);
    };
    match run(action, dialect, uri, vectors).await {
        Ok(result) => println!("{result}"),
        Err(e) => {
            eprintln!("apply runner: {e}");
            std::process::exit(1);
        }
    }
}

async fn run(action: &str, dialect: &str, uri: &str, vectors: &str) -> Result<String, String> {
    if action == "lock-wait" {
        return lock_wait(dialect, uri, vectors).await;
    }
    let plans = chain(vectors)?;
    match dialect {
        "mysql" => {
            on(sqlx::MySqlConnection::connect(uri).await.map_err(|e| e.to_string())?, Dialect::MySql, &["SET time_zone = '+00:00'"], action, &plans).await
        }
        "postgres" => {
            on(sqlx::PgConnection::connect(uri).await.map_err(|e| e.to_string())?, Dialect::Postgres, &["SET TimeZone = 'UTC'"], action, &plans).await
        }
        "sqlite" => {
            on(sqlx::SqliteConnection::connect(uri).await.map_err(|e| e.to_string())?, Dialect::Sqlite, &["PRAGMA foreign_keys = ON"], action, &plans).await
        }
        other => Err(format!("unknown dialect {other}")),
    }
}

async fn lock_wait(dialect: &str, uri: &str, vectors: &str) -> Result<String, String> {
    match dialect {
        "mysql" => statement_lock_wait::<sqlx::MySqlConnection>(uri, Dialect::MySql, "SET time_zone = '+00:00'", vectors).await,
        "postgres" => statement_lock_wait::<sqlx::PgConnection>(uri, Dialect::Postgres, "SET TimeZone = 'UTC'", vectors).await,
        "sqlite" => {
            let plans = chain(vectors)?;
            let mut c = sqlx::SqliteConnection::connect(uri).await.map_err(|e| e.to_string())?;
            ApplyConnection::execute(&mut c, "PRAGMA foreign_keys = ON").await.map_err(|e| e.to_string())?;
            let mut blocker = sqlx::SqliteConnection::connect(uri).await.map_err(|e| e.to_string())?;
            ApplyConnection::execute(&mut blocker, "BEGIN EXCLUSIVE").await.map_err(|e| e.to_string())?;
            check_sqlite_lock_wait(&mut c, &mut blocker, &plans).await
        }
        other => Err(format!("unknown dialect {other}")),
    }
}

/// The lock wait of a MySQL or PostgreSQL apply: the base plan of the representative chain is applied, a second
/// session locks the archive rows, and the apply of the target plan must fail at its first statement on that lock.
async fn statement_lock_wait<C: ApplyConnection + Connection + Send>(uri: &str, dialect: Dialect, zone: &str, vectors: &str) -> Result<String, String> {
    let plans = representative_chain(vectors)?;
    let mut c = C::connect(uri).await.map_err(|e| e.to_string())?;
    ApplyConnection::execute(&mut c, zone).await.map_err(|e| e.to_string())?;
    quiet_apply(&mut c, dialect, &plans[..1]).await?;
    let mut blocker = C::connect(uri).await.map_err(|e| e.to_string())?;
    for statement in ["BEGIN", "INSERT INTO archive (note) VALUES ('lock wait')", "SELECT id FROM archive FOR UPDATE"] {
        ApplyConnection::execute(&mut blocker, statement).await.map_err(|error| format!("lock blocker: {error}"))?;
    }
    let result = check_statement_wait(&mut c, dialect, &plans).await;
    let cleanup = ApplyConnection::execute(&mut blocker, "ROLLBACK").await.map_err(|e| e.to_string());
    combine_cleanup(result, cleanup)
}

async fn quiet_apply<C: ApplyConnection + Send>(c: &mut C, dialect: Dialect, plans: &[Plan]) -> Result<(), String> {
    let mut quiet = |_: &ApplyEvent| -> Result<(), EventError> { Ok(()) };
    apply(c, dialect, plans, &fixed_now, &mut quiet).await.map_err(|e| e.to_string())
}

async fn check_statement_wait<C: ApplyConnection + Send>(c: &mut C, dialect: Dialect, plans: &[Plan]) -> Result<String, String> {
    let mut events = Vec::new();
    let started = std::time::Instant::now();
    let result = apply(c, dialect, plans, &fixed_now, &mut record_steps(&mut events)).await;
    let elapsed = started.elapsed();
    let (plan, step, source) = match result {
        Err(ApplyError::Failed { plan, step, source, .. }) => (plan, step, source),
        Err(error) => return Err(format!("statement lock wait returned a non-step error: {error}")),
        Ok(()) => return Err("apply succeeded while the representative statement was locked".to_owned()),
    };
    if plan != "representative" || step != 0 {
        return Err(format!("statement lock wait failed at {plan} step {step}; want representative step 0"));
    }
    let detail = source.to_string().to_lowercase();
    if !detail.contains("lock") && !detail.contains("timeout") {
        return Err(format!("statement failure does not name the held lock: {source}"));
    }
    if events != [(ApplyEventKind::Statement, 0)] {
        return Err(format!("statement events = {events:?}; want only statement 0"));
    }
    if elapsed < std::time::Duration::from_secs(4) || elapsed >= std::time::Duration::from_secs(10) {
        return Err(format!("statement lock wait returned after {elapsed:?}; want 4s <= elapsed < 10s"));
    }
    Ok("error failed".to_owned())
}

async fn check_sqlite_lock_wait(c: &mut sqlx::SqliteConnection, blocker: &mut sqlx::SqliteConnection, plans: &[Plan]) -> Result<String, String> {
    let mut quiet = |_: &ApplyEvent| -> Result<(), EventError> { Ok(()) };
    let mut guarded = ReleaseSqliteBlocker { inner: c, blocker, released: false, release_error: None };
    let started = std::time::Instant::now();
    let result = apply(&mut guarded, Dialect::Sqlite, plans, &fixed_now, &mut quiet).await;
    let elapsed = started.elapsed();
    let released = guarded.released;
    let release_error = guarded.release_error.take();
    drop(guarded);
    let cleanup = if released { Ok(()) } else { ApplyConnection::execute(blocker, "ROLLBACK").await.map_err(|e| e.to_string()) };
    let (message, source) = match result {
        Err(ApplyError::Locked { message, source: Some(source) }) => (message, source),
        Err(error) => return combine_cleanup(Err(format!("SQLite lock wait returned a non-lock error: {error}")), cleanup),
        Ok(()) => return combine_cleanup(Err("SQLite apply succeeded while another connection held an exclusive lock".to_owned()), cleanup),
    };
    if let Some(error) = release_error {
        return combine_cleanup(Err(format!("release SQLite blocker after BEGIN EXCLUSIVE: {error}")), cleanup);
    }
    cleanup.map_err(|e| format!("SQLite blocker cleanup: {e}"))?;
    if !format!("{message} {source}").to_lowercase().contains("lock") {
        return Err(format!("SQLite failure does not name the held lock: {message}: {source}"));
    }
    if elapsed < std::time::Duration::from_secs(4) || elapsed >= std::time::Duration::from_secs(10) {
        return Err(format!("SQLite lock wait returned after {elapsed:?}; want 4s <= elapsed < 10s"));
    }
    Ok("error locked".to_owned())
}

struct ReleaseSqliteBlocker<'a> {
    inner: &'a mut sqlx::SqliteConnection,
    blocker: &'a mut sqlx::SqliteConnection,
    released: bool,
    release_error: Option<String>,
}

impl CatalogQuerier for ReleaseSqliteBlocker<'_> {
    async fn rows(&mut self, query: &str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        self.inner.rows(query).await
    }
}

impl ApplyConnection for ReleaseSqliteBlocker<'_> {
    async fn execute(&mut self, statement: &str) -> Result<(), sqlx::Error> {
        let result = ApplyConnection::execute(self.inner, statement).await;
        if statement == "BEGIN EXCLUSIVE" && result.is_err() && !self.released {
            match ApplyConnection::execute(self.blocker, "ROLLBACK").await {
                Ok(()) => self.released = true,
                Err(error) => self.release_error = Some(error.to_string()),
            }
        }
        result
    }
    async fn execute_bound(&mut self, statement: &str, args: &[CatalogValue]) -> Result<(), sqlx::Error> {
        self.inner.execute_bound(statement, args).await
    }
    async fn query_bound(&mut self, query: &str, args: &[CatalogValue]) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        self.inner.query_bound(query, args).await
    }
}

fn combine_cleanup(result: Result<String, String>, cleanup: Result<(), String>) -> Result<String, String> {
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(format!("lock blocker cleanup: {error}")),
        (Err(error), Err(cleanup)) => Err(format!("{error}; lock blocker cleanup: {cleanup}")),
    }
}

/// create-from-empty and rename-table-and-column from plans.json at the path.
fn chain(path: &str) -> Result<Vec<Plan>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let vectors: Value = serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
    let mut plans = Vec::new();
    for c in vectors["cases"].as_array().ok_or("plans.json has no cases")? {
        if !matches!(c["id"].as_str(), Some("create-from-empty" | "rename-table-and-column")) {
            continue;
        }
        let lines = c["plan"].as_array().ok_or("a plan case has no plan lines")?;
        let mut source = String::new();
        for line in lines {
            source.push_str(line.as_str().ok_or("a plan line is not text")?);
            source.push('\n');
        }
        plans.push(parse_plan(&source).map_err(|e| format!("{}: {e:?}", c["id"]))?);
    }
    if plans.len() != 2 || plans[1].from() != Some(plans[0].to()) {
        return Err("plans.json does not chain create-from-empty and rename-table-and-column".to_owned());
    }
    Ok(plans)
}

fn representative_chain(path: &str) -> Result<Vec<Plan>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let vectors: Value = serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))?;
    let case =
        vectors["cases"].as_array().and_then(|cases| cases.iter().find(|c| c["id"] == "representative")).ok_or("plans.json has no representative case")?;
    let source_lines = case["source"].as_array().ok_or("representative has no source lines")?;
    let mut source = String::from("dbplan 1 base\nfrom empty\n\n");
    for line in source_lines {
        source.push_str(line.as_str().ok_or("representative source line is not text")?);
        source.push('\n');
    }
    let target_lines = case["plan"].as_array().ok_or("representative has no plan lines")?;
    let mut target = String::new();
    for line in target_lines {
        target.push_str(line.as_str().ok_or("representative plan line is not text")?);
        target.push('\n');
    }
    let plans = vec![
        parse_plan(&source).map_err(|e| format!("representative source: {e:?}"))?,
        parse_plan(&target).map_err(|e| format!("representative plan: {e:?}"))?,
    ];
    if plans[1].from() != Some(plans[0].to()) {
        return Err("representative plans do not chain".to_owned());
    }
    Ok(plans)
}

/// tool clock: 2026-10-01T00:00:00.123456789Z. applied_at in history is truncated to six fractional digits.
fn fixed_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).single().expect("fixed time") + chrono::Duration::nanoseconds(123_456_789)
}

/// Runs the connection rules on the connection, then runs the action and returns the result line.
async fn on<C: ApplyConnection + Send>(mut c: C, dialect: Dialect, rules: &[&str], action: &str, plans: &[Plan]) -> Result<String, String> {
    for rule in rules {
        c.execute(rule).await.map_err(|e| format!("{rule}: {e}"))?;
    }
    let mut quiet = |_: &ApplyEvent| -> Result<(), EventError> { Ok(()) };
    let second = plans[1].name().to_owned();
    let mut stop = |e: &ApplyEvent| -> Result<(), EventError> {
        if e.kind == ApplyEventKind::Applied && e.plan == second && e.step == 1 {
            return Err(Box::new(Stop));
        }
        Ok(())
    };
    let result = match action {
        "apply-first" => apply(&mut c, dialect, &plans[..1], &fixed_now, &mut quiet).await,
        "apply" => apply(&mut c, dialect, plans, &fixed_now, &mut quiet).await,
        "recover" => recover(&mut c, dialect, plans, &fixed_now, &mut quiet).await,
        "rollback" => rollback(&mut c, dialect, plans, &fixed_now, &mut quiet).await,
        "stop" => match apply(&mut c, dialect, plans, &fixed_now, &mut stop).await {
            Err(ApplyError::Event(e)) if e.downcast_ref::<Stop>().is_some() => return Ok("stopped".to_owned()),
            Ok(()) => return Err("stop: apply did not stop".to_owned()),
            other => other,
        },
        other => return Err(format!("unknown action {other}")),
    };
    match result {
        Ok(()) => Ok("ok".to_owned()),
        Err(e) => match e.code() {
            Some(code) if !matches!(e, ApplyError::Cleanup { .. }) => Ok(format!("error {code}")),
            _ => Err(e.to_string()),
        },
    }
}
