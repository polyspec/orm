//! Applies the chain from plans.json (tests/dbspec/plans.json) (create-from-empty and
//! rename-table-and-column) to one database with the Rust client
//! (docs/plans.md "Apply"). The action is apply-first (first plan only), apply (whole chain),
//! stop (halts after statement 1 of the second plan runs), recover (continues an interrupted plan
//! to the end), rollback (reverts the last plan in history). One result line goes to stdout: "ok", "stopped", or
//! "error <code>". Any other error is written to stderr and the process exits with 1.
//!
//! Usage: dbspec_apply <apply-first|apply|stop|recover|rollback> <mysql|postgres|sqlite> <uri> <plans.json>

use chrono::{DateTime, TimeZone, Utc};
use polyspec_orm::dbspec::{apply, parse_plan, recover, rollback, ApplyConnection, ApplyError, ApplyEvent, ApplyEventKind, Dialect, Plan};
use serde_json::Value;
use sqlx::Connection;

type EventError = Box<dyn std::error::Error + Send + Sync>;

/// The error by which the stop action halts apply at an event.
#[derive(Debug)]
struct Stop;

impl std::fmt::Display for Stop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("stop")
    }
}

impl std::error::Error for Stop {}

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
