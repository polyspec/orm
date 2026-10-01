//! plans.json(tests/dbspec/plans.json)의 chain(create-from-empty와
//! rename-table-and-column)을 Rust client로 한 database에 적용한다
//! (docs/plans.md "Apply"). action은 apply-first(첫 plan만), apply(chain 전체),
//! stop(둘째 plan의 statement 1이 실행된 뒤 멈춤), recover(중단된 MySQL plan을
//! 끝냄) 중 하나다. stdout에는 결과 한 줄을 쓴다: "ok", "stopped" 또는
//! "error <code>". 그 밖의 error는 stderr에 쓰고 1로 끝난다.
//!
//! Usage: dbspec_apply <apply-first|apply|stop|recover> <mysql|postgres|sqlite> <uri> <plans.json>

use chrono::{DateTime, TimeZone, Utc};
use orm::dbspec::{apply, parse_plan, recover, ApplyConnection, ApplyError, ApplyEvent, ApplyEventKind, Dialect, Plan};
use serde_json::Value;
use sqlx::Connection;

type EventError = Box<dyn std::error::Error + Send + Sync>;

/// stop action이 event에서 apply를 멈추는 error.
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
        eprintln!("usage: dbspec_apply <apply-first|apply|stop|recover> <mysql|postgres|sqlite> <uri> <plans.json>");
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

/// path의 plans.json에서 create-from-empty와 rename-table-and-column.
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

fn fixed_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).single().expect("fixed time")
}

/// connection에 연결 규칙을 실행한 뒤 action을 실행하고 결과 줄을 돌려준다.
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
