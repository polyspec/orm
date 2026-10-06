//! Every case of tests/dbspec/plans.json applied to MySQL, PostgreSQL and
//! SQLite through the Rust client (docs/plans.md, "Verification"): the source
//! rendered by `dbspec::render`, the `before` steps and the `dbspec::plan_steps`
//! steps before finalize, after which `polyspec_orm::dbspec::introspect` reads the
//! plan's target schema text with no unsupported object; without an
//! irreversible step the rollback statements return to the source schema text
//! and the steps run again; then the `after` steps and the finalize steps
//! run, the target is read again and no `dbspec$` table or column remains. A test
//! fails when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.

#[path = "common/dbspec_probe.rs"]
mod dbspec_probe;

use dbspec_probe::{connection_rules, lines, repository, run_probe, strings, Conn, Servers, DIALECTS};
use polyspec_orm_schema::dbspec::{self, parse_plan, plan_steps, Document};
use serde_json::Value;
use sqlx::{AssertSqlSafe, Row, SqlSafeStr, TypeInfo, ValueRef};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// tests/dbspec/ddl.json 형식의 step 하나: `query`와 `want`, 실패해야 하는 `sql`,
/// 또는 실행할 `sql`. `dialects`가 있으면 그 database에서만 실행한다.
struct Step {
    sql: Option<String>,
    fails: bool,
    query: Option<String>,
    want: Option<String>,
    dialects: Vec<String>,
}

fn steps(value: &Value) -> Vec<Step> {
    value
        .as_array()
        .expect("steps")
        .iter()
        .map(|step| Step {
            sql: step["sql"].as_str().map(str::to_owned),
            fails: step["fails"].as_bool().unwrap_or(false),
            query: step["query"].as_str().map(str::to_owned),
            want: step["want"].as_str().map(str::to_owned),
            dialects: if step["dialects"].is_null() { Vec::new() } else { strings(&step["dialects"]) },
        })
        .collect()
}

/// `query`의 첫 행 첫 값을 Go probe의 `Value`처럼 text로 읽는다: SQL NULL은
/// `NULL`이고 정수, decimal, text가 아닌 type은 error다.
async fn value(conn: &mut Conn, query: &str) -> Result<String, String> {
    let sql = || AssertSqlSafe(query.to_owned()).into_sql_str();
    let result = match conn {
        Conn::MySql(c) => sqlx::query(sql()).fetch_one(c).await.map_err(|e| e.to_string()).and_then(|row| text_value(&row, mysql_other)),
        Conn::Postgres(c) => sqlx::query(sql()).fetch_one(c).await.map_err(|e| e.to_string()).and_then(|row| text_value(&row, postgres_other)),
        Conn::Sqlite(c) => sqlx::query(sql()).fetch_one(c).await.map_err(|e| e.to_string()).and_then(|row| text_value(&row, sqlite_other)),
    };
    result.map_err(|e| format!("{query}: {e}"))
}

/// 한 행의 첫 값을 text로 쓴다. 정수와 text가 아닌 type은 `other`가 읽는다.
fn text_value<R: Row>(row: &R, other: impl Fn(&R, &str) -> Result<String, sqlx::Error>) -> Result<String, String>
where
    usize: sqlx::ColumnIndex<R>,
    for<'r> i64: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
    for<'r> String: sqlx::Decode<'r, R::Database> + sqlx::Type<R::Database>,
{
    let raw = row.try_get_raw(0).map_err(|e| e.to_string())?;
    if raw.is_null() {
        return Ok("NULL".to_owned());
    }
    let type_name = raw.type_info().name().to_owned();
    match type_name.as_str() {
        "TINYINT" | "SMALLINT" | "INT" | "BIGINT" | "INT2" | "INT4" | "INT8" | "INTEGER" => row.try_get::<i64, _>(0).map(|v| v.to_string()),
        "VARCHAR" | "CHAR" | "TEXT" => row.try_get::<String, _>(0),
        name => other(row, name),
    }
    .map_err(|e| e.to_string())
}

fn no_text_form(name: &str) -> sqlx::Error {
    sqlx::Error::Decode(format!("a value of type {name} has no text form here").into())
}

/// MySQL의 decimal과 binary collation 문자열. 문자열은 UTF-8 text다.
fn mysql_other(row: &sqlx::mysql::MySqlRow, name: &str) -> Result<String, sqlx::Error> {
    match name {
        "DECIMAL" => row.try_get::<rust_decimal::Decimal, _>(0).map(|v| v.to_string()),
        "VARBINARY" | "BINARY" => {
            let bytes: Vec<u8> = row.try_get(0)?;
            String::from_utf8(bytes).map_err(|e| sqlx::Error::Decode(e.into()))
        }
        _ => Err(no_text_form(name)),
    }
}

fn postgres_other(row: &sqlx::postgres::PgRow, name: &str) -> Result<String, sqlx::Error> {
    match name {
        "NUMERIC" => row.try_get::<rust_decimal::Decimal, _>(0).map(|v| v.to_string()),
        _ => Err(no_text_form(name)),
    }
}

fn sqlite_other(_: &sqlx::sqlite::SqliteRow, name: &str) -> Result<String, sqlx::Error> {
    Err(no_text_form(name))
}

/// 이름이 dbspec$로 시작하는 table과 column의 수를 읽는 query.
fn hidden_left(db: &str) -> &'static str {
    match db {
        "mysql" => "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'dbspec$%' OR COLUMN_NAME LIKE 'dbspec$%')",
        "postgres" => "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND (c.relname LIKE 'dbspec$%' OR a.attname LIKE 'dbspec$%')",
        _ => "SELECT COUNT(*) FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND (m.name LIKE 'dbspec$%' OR p.name LIKE 'dbspec$%')",
    }
}

/// SQLite에서 foreign key를 어기는 row가 없는지 확인한다.
async fn foreign_key_check(conn: &mut Conn, db: &str) -> Result<(), String> {
    if db != "sqlite" {
        return Ok(());
    }
    let violations = value(conn, "SELECT COUNT(*) FROM pragma_foreign_key_check").await?;
    if violations != "0" {
        return Err(format!("PRAGMA foreign_key_check returns {violations} rows"));
    }
    Ok(())
}

/// introspect한 schema text가 `want`(빈 database이면 빈 문자열)인지 확인한다.
async fn schema_is(conn: &mut Conn, what: &str, want: &str) -> Result<(), String> {
    let (introspection, _) = conn.introspect().await.map_err(|e| format!("{what}: introspect: {e}"))?;
    if !introspection.unsupported.is_empty() {
        return Err(format!("{what}: unsupported: {:?}", introspection.unsupported));
    }
    let got = if introspection.document.tables.is_empty() {
        String::new()
    } else {
        dbspec::manifest(&[&introspection.document]).map_err(|e| format!("{what}: manifest: {e:?}"))?.schema_text
    };
    if got != want {
        return Err(format!("{what}: schema text differs\n--- want\n{want}--- got\n{got}"));
    }
    Ok(())
}

async fn run_steps(conn: &mut Conn, db: &str, steps: &[Step]) -> Result<(), String> {
    for step in steps.iter().filter(|s| s.dialects.is_empty() || s.dialects.iter().any(|d| d == db)) {
        match (&step.query, &step.sql) {
            (Some(query), _) => {
                let want = step.want.as_deref().ok_or_else(|| format!("{query}: a query step has no want"))?;
                let got = value(conn, query).await?;
                if got != want {
                    return Err(format!("{query}: got {got:?}; want {want:?}"));
                }
            }
            (None, Some(sql)) if step.fails => match conn.exec(sql).await {
                Ok(()) => return Err(format!("{sql}: succeeded; want an error")),
                Err(e) => orm_testcase::step(format_args!("expected failure {e}")),
            },
            (None, Some(sql)) => conn.exec(sql).await?,
            (None, None) => return Err("a step has neither query nor sql".to_owned()),
        }
    }
    Ok(())
}

#[tokio::test]
async fn plan_apply() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    let started = Instant::now();
    let path = repository().join("tests/dbspec/plans.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("plans.json")).expect("plans.json");
    let cases = vectors["cases"].as_array().expect("plan cases");
    assert!(!cases.is_empty(), "tests/dbspec/plans.json has no cases");
    let mut servers = Servers::open("plan").await;
    let mut failures = Vec::new();
    let mut runs = 0;
    for case in cases {
        let case_id = case["id"].as_str().expect("id");
        let plan = parse_plan(&lines(&case["plan"])).unwrap_or_else(|e| panic!("{case_id}: {e:?}"));
        let source: Option<Document> =
            (!case["source"].is_null()).then(|| dbspec::parse(&lines(&case["source"]), &BTreeMap::new()).unwrap_or_else(|e| panic!("{case_id}: {e:?}")));
        for (db, dialect) in DIALECTS {
            let setup = match &source {
                None => Vec::new(),
                Some(source) => dbspec::render(&[source], dialect).unwrap_or_else(|e| panic!("{case_id}: {e:?}")),
            };
            let steps_of = plan_steps(source.as_ref(), &plan, dialect).unwrap_or_else(|e| panic!("{case_id}: {e:?}"));
            let reversible = steps_of.iter().all(|s| s.finalize || !s.rollback.is_empty());
            let want = plan.schema_text().to_owned();
            let source_text = source.as_ref().map(|d| dbspec::manifest(&[d]).expect("source manifest").schema_text).unwrap_or_default();
            let id = format!("{db}.plan.{}", case_id.replace('-', "_"));
            runs += 1;
            let (before, after) = (steps(&case["before"]), steps(&case["after"]));
            orm_testcase::step(format_args!("{id}: {} steps, reversible {reversible}", steps_of.len()));
            let result = run_probe(&mut servers, &id, db, runs, |conn| {
                Box::pin(async move {
                    let forward: Vec<String> = steps_of.iter().take_while(|s| !s.finalize).map(|s| s.statement.clone()).collect();
                    let again: Vec<String> = steps_of
                        .iter()
                        .take_while(|s| !s.finalize)
                        .map(|s| if s.restore.is_empty() { s.statement.clone() } else { s.restore.clone() })
                        .collect();
                    // 끝까지 되돌리는 rollback은 옛 table을 숨긴 더한 column과 함께 다시 만든다.
                    let back: Vec<String> = steps_of
                        .iter()
                        .rev()
                        .filter(|s| !s.finalize)
                        .map(|s| if s.rollback_restore.is_empty() { s.rollback.clone() } else { s.rollback_restore.clone() })
                        .collect();
                    let finalize: Vec<String> = steps_of.iter().filter(|s| s.finalize).map(|s| s.statement.clone()).collect();
                    conn.exec_all(&connection_rules(db).iter().map(|s| (*s).to_owned()).collect::<Vec<_>>()).await?;
                    conn.exec_all(&setup).await?;
                    run_steps(conn, db, &before).await?;
                    // SQLite는 table을 다시 만드는 동안 foreign key를 끄고, 끝난 뒤 검사한다.
                    if db == "sqlite" {
                        conn.exec("PRAGMA foreign_keys = OFF").await?;
                        conn.exec("PRAGMA legacy_alter_table = OFF").await?;
                    }
                    conn.exec_all(&forward).await?;
                    foreign_key_check(conn, db).await?;
                    schema_is(conn, "applied", &want).await?;
                    if reversible {
                        conn.exec_all(&back).await?;
                        foreign_key_check(conn, db).await?;
                        schema_is(conn, "rolled back", &source_text).await?;
                        conn.exec_all(&again).await?;
                        foreign_key_check(conn, db).await?;
                        schema_is(conn, "applied again", &want).await?;
                    }
                    if db == "sqlite" {
                        conn.exec("PRAGMA foreign_keys = ON").await?;
                    }
                    run_steps(conn, db, &after).await?;
                    // finalize도 apply처럼 SQLite foreign key를 끄고 실행한다.
                    if db == "sqlite" {
                        conn.exec("PRAGMA foreign_keys = OFF").await?;
                    }
                    conn.exec_all(&finalize).await?;
                    if db == "sqlite" {
                        conn.exec("PRAGMA foreign_keys = ON").await?;
                    }
                    schema_is(conn, "finalized", &want).await?;
                    let hidden = value(conn, hidden_left(db)).await?;
                    if hidden != "0" {
                        return Err(format!("{hidden} hidden tables or columns remain after finalize"));
                    }
                    Ok(())
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
    assert_eq!(runs, cases.len() * DIALECTS.len(), "plan runs");
    // 세 database의 plan 적용은 개발 machine에서 몇 초 걸린다(T27 측정 8 s, build 포함). 5분이 지나면 멈춘 것이다.
    if started.elapsed() >= Duration::from_secs(300) {
        orm_testcase::warning(format_args!("plan apply exceeded 300s"));
    }
    orm_testcase::step(format_args!("dbspec plan apply: {runs} runs of {} cases on three databases in {:?}", cases.len(), started.elapsed()));
}
