//! Plan chains applied to MySQL, PostgreSQL and SQLite through
//! `polyspec_orm::dbspec::apply`, `recover`, `rollback` and `finalize` (docs/spec/plans.md,
//! "Apply"): the chain of create-from-empty and rename-table-and-column of
//! tests/dbspec/plans.json with its history and a second apply without
//! events, drift, the lock of a second session, an apply to a second
//! database, schema or file while the first holds its lock, the empty chain,
//! an unlock that released nothing on PostgreSQL, a failed verification; for
//! every step of the representative case a stop after its statement followed
//! by rollback, a stop followed by recover and a stopped rollback that
//! continues; rows written between apply, rollback and a second apply; the
//! null check of a dropped required column; and finalize. A test fails when
//! ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.

#[path = "common/dbspec_probe.rs"]
mod dbspec_probe;

use chrono::{DateTime, TimeZone, Utc};
use dbspec_probe::{connection_rules, lines, repository, require_dsn, run_probe, Conn, Servers, Session, DIALECTS};
use polyspec_orm::db::{parse_dsn, ConnectOptions};
use polyspec_orm::dbspec::{
    self, apply, finalize, parse_plan, plan_steps, recover, rollback, ApplyConnection, ApplyError, ApplyEvent, ApplyEventKind, CatalogQuerier, CatalogValue,
    Dialect, Plan,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

type EventError = Box<dyn std::error::Error + Send + Sync>;

/// The error that halts apply in an event handler.
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

/// create-from-empty from tests/dbspec/plans.json, and the chain starting from its target
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

/// tool clock: 2026-10-01T00:00:00.123456789Z. applied_at in history is truncated to six fractional digits.
fn fixed_now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).single().expect("fixed time") + chrono::Duration::nanoseconds(123_456_789)
}

/// Right after the statement that starts with `after` runs, runs statement `then` once
/// on the same connection. An event handler cannot use the connection apply borrowed, so, unlike Go,
/// the test runs at this point the statement it would run in the event.
struct RunAfter<'c, C> {
    inner: &'c mut C,
    after: String,
    then: String,
    done: bool,
}

impl<C: CatalogQuerier + Send> CatalogQuerier for RunAfter<'_, C> {
    async fn rows(&mut self, query: &str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        self.inner.rows(query).await
    }
}

impl<C: ApplyConnection + Send> ApplyConnection for RunAfter<'_, C> {
    async fn execute(&mut self, statement: &str) -> Result<(), sqlx::Error> {
        self.inner.execute(statement).await?;
        if !self.done && statement.starts_with(&self.after) {
            self.done = true;
            self.inner.execute(&self.then).await?;
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

/// The lock name and key of docs/spec/plans.md "Apply".
const MYSQL_APPLY_LOCK: &str = "CONCAT('dbspec$plans$', LEFT(SHA2(DATABASE(), 256), 51))";
const POSTGRES_APPLY_LOCK: &str = "hashtext('dbspec$plans'), hashtext(current_schema())";

/// Runs the statement that creates the history table (the first statement after taking the lock),
/// then immediately applies the chain once on a second connection and records the result.
struct ApplyOtherUnderLock<'c, C> {
    inner: &'c mut C,
    other: &'c mut Conn,
    plans: &'c [Plan],
    result: Option<Result<(), ApplyError>>,
}

impl<C: CatalogQuerier + Send> CatalogQuerier for ApplyOtherUnderLock<'_, C> {
    async fn rows(&mut self, query: &str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        self.inner.rows(query).await
    }
}

impl<C: ApplyConnection + Send> ApplyConnection for ApplyOtherUnderLock<'_, C> {
    async fn execute(&mut self, statement: &str) -> Result<(), sqlx::Error> {
        self.inner.execute(statement).await?;
        if self.result.is_none() && statement.starts_with("CREATE TABLE IF NOT EXISTS") {
            let plans = self.plans;
            self.result = Some(match &mut *self.other {
                Conn::MySql(c) => apply(c, Dialect::MySql, plans, &fixed_now, &mut quiet).await,
                Conn::Postgres(c) => apply(c, Dialect::Postgres, plans, &fixed_now, &mut quiet).await,
                Conn::Sqlite(c) => apply(c, Dialect::Sqlite, plans, &fixed_now, &mut quiet).await,
            });
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

/// The kind of command.
#[derive(Clone, Copy)]
enum Command {
    Apply,
    Recover,
    Rollback,
    Finalize,
}

/// Runs a command on one probe connection. If `run_after` is `(after, then)`,
/// it runs statement `then` after the statement that starts with `after`.
async fn run(
    conn: &mut Conn,
    command: Command,
    plans: &[Plan],
    run_after: Option<(&str, &str)>,
    events: &mut (dyn FnMut(&ApplyEvent) -> Result<(), EventError> + Send),
) -> Result<(), ApplyError> {
    async fn command_on<C: ApplyConnection + Send + ?Sized>(
        c: &mut C,
        dialect: Dialect,
        command: Command,
        plans: &[Plan],
        events: &mut (dyn FnMut(&ApplyEvent) -> Result<(), EventError> + Send),
    ) -> Result<(), ApplyError> {
        match command {
            Command::Apply => apply(c, dialect, plans, &fixed_now, events).await,
            Command::Recover => recover(c, dialect, plans, &fixed_now, events).await,
            Command::Rollback => rollback(c, dialect, plans, &fixed_now, events).await,
            Command::Finalize => finalize(c, dialect, plans, &fixed_now, events).await,
        }
    }
    async fn on<C: ApplyConnection + Send>(
        c: &mut C,
        dialect: Dialect,
        command: Command,
        plans: &[Plan],
        run_after: Option<(&str, &str)>,
        events: &mut (dyn FnMut(&ApplyEvent) -> Result<(), EventError> + Send),
    ) -> Result<(), ApplyError> {
        match run_after {
            Some((after, then)) => {
                let mut wrapped = RunAfter { inner: c, after: after.to_owned(), then: then.to_owned(), done: false };
                command_on(&mut wrapped, dialect, command, plans, events).await
            }
            None => command_on(c, dialect, command, plans, events).await,
        }
    }
    match conn {
        Conn::MySql(c) => on(c, Dialect::MySql, command, plans, run_after, events).await,
        Conn::Postgres(c) => on(c, Dialect::Postgres, command, plans, run_after, events).await,
        Conn::Sqlite(c) => on(c, Dialect::Sqlite, command, plans, run_after, events).await,
    }
}

fn quiet(_: &ApplyEvent) -> Result<(), EventError> {
    Ok(())
}

/// Reads the only value of `query` as text.
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

/// Joins all rows of `query` as `a|b`, with rows joined by commas.
async fn rows_text(conn: &mut Conn, query: &str) -> Result<String, String> {
    let rows = match conn {
        Conn::MySql(c) => c.query_bound(query, &[]).await,
        Conn::Postgres(c) => c.query_bound(query, &[]).await,
        Conn::Sqlite(c) => c.query_bound(query, &[]).await,
    }
    .map_err(|e| format!("{query}: {e}"))?;
    let cell = |v: &CatalogValue| match v {
        CatalogValue::Null => "NULL".to_owned(),
        CatalogValue::Text(s) => s.clone(),
        CatalogValue::Int(n) => n.to_string(),
        CatalogValue::Bool(b) => b.to_string(),
    };
    Ok(rows.iter().map(|r| r.iter().map(cell).collect::<Vec<_>>().join("|")).collect::<Vec<_>>().join(","))
}

async fn rows_are(conn: &mut Conn, query: &str, expected: &str) -> Result<(), String> {
    let got = rows_text(conn, query).await?;
    if got == expected {
        Ok(())
    } else {
        Err(format!("{query}: got {got:?}; want {expected:?}"))
    }
}

async fn history_is(conn: &mut Conn, db: &str, expected: &str) -> Result<(), String> {
    rows_are(conn, &format!("SELECT name, state, step FROM {} ORDER BY name", history(db)), expected).await
}

async fn want(conn: &mut Conn, query: &str, expected: &str) -> Result<(), String> {
    let got = scalar(conn, query).await?;
    if got == expected {
        Ok(())
    } else {
        Err(format!("{query}: got {got:?}; want {expected:?}"))
    }
}

/// Checks that the introspected schema text is `expected` (an empty string if the database is empty).
async fn schema_is(conn: &mut Conn, expected: &str) -> Result<(), String> {
    let (introspection, _) = conn.introspect().await.map_err(|e| format!("introspect: {e}"))?;
    if !introspection.unsupported.is_empty() {
        return Err(format!("unsupported: {:?}", introspection.unsupported));
    }
    let got = if introspection.document.tables.is_empty() {
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

/// For each dialect, the chain plan's (step count, number of steps before finalize).
type Counts = BTreeMap<&'static str, Vec<(usize, usize)>>;

fn counts(chain: &[Plan]) -> Counts {
    DIALECTS
        .iter()
        .map(|&(name, dialect)| {
            let list = chain
                .iter()
                .enumerate()
                .map(|(i, p)| {
                    let source = (i > 0).then(|| chain[i - 1].schema());
                    let steps = plan_steps(source, p, dialect).unwrap_or_else(|e| panic!("{}: {e:?}", p.name()));
                    (steps.len(), steps.iter().position(|s| s.finalize).unwrap_or(steps.len()))
                })
                .collect();
            (name, list)
        })
        .collect()
}

/// A chain made of the first plan base that creates the case's source and the case's plan.
fn case_chain(id: &str) -> Vec<Plan> {
    let path = repository().join("tests/dbspec/plans.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("plans.json")).expect("plans.json");
    let case = vectors["cases"].as_array().expect("plan cases").iter().find(|c| c["id"] == id).unwrap_or_else(|| panic!("plans.json has no case {id}"));
    let base = parse_plan(&format!("dbplan 1 base\nfrom empty\n\n{}", lines(&case["source"]))).unwrap_or_else(|e| panic!("{id} base: {e:?}"));
    let plan = parse_plan(&lines(&case["plan"])).unwrap_or_else(|e| panic!("{id}: {e:?}"));
    assert_eq!(plan.from(), Some(base.to()), "the source of {id} does not start its plan");
    vec![base, plan]
}

fn schema_text(p: &Plan) -> String {
    dbspec::manifest(&[p.schema()]).expect("plan manifest").schema_text
}

/// The number of tables and columns whose names start with dbspec$, excluding the history table.
fn hidden_left(db: &str) -> &'static str {
    match db {
        "mysql" => "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME LIKE 'dbspec$%' OR COLUMN_NAME LIKE 'dbspec$%') AND TABLE_NAME <> 'dbspec$plans'",
        "postgres" => "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND (c.relname LIKE 'dbspec$%' OR a.attname LIKE 'dbspec$%') AND c.relname <> 'dbspec$plans'",
        _ => "SELECT COUNT(*) FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND (m.name LIKE 'dbspec$%' OR p.name LIKE 'dbspec$%') AND m.name <> 'dbspec$plans'",
    }
}

/// An event handler that halts the command after running the plan's step-th statement, before the step is recorded.
fn stop_after(plan: String, step: usize) -> impl FnMut(&ApplyEvent) -> Result<(), EventError> + Send {
    move |e: &ApplyEvent| {
        if e.kind == ApplyEventKind::Applied && e.plan == plan && e.step == step {
            return Err(Box::new(Stop));
        }
        Ok(())
    }
}

async fn chain_history_and_again(conn: &mut Conn, db: &str, plans: &[Plan], target: &str, c: &[(usize, usize)]) -> Result<(), String> {
    let mut counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut record = |e: &ApplyEvent| -> Result<(), EventError> {
        *counts.entry(e.kind.as_str()).or_default() += 1;
        Ok(())
    };
    run(conn, Command::Apply, plans, None, &mut record).await.map_err(|e| format!("apply: {e}"))?;
    schema_is(conn, target).await?;
    history_is(conn, db, &format!("create_from_empty|applied|{},rename_table_and_column|applied|{}", c[0].1, c[1].1)).await?;
    // applied_at is the tool clock's UTC time truncated to six fractional digits, as text.
    want(conn, &format!("SELECT COUNT(*) FROM {} WHERE applied_at = '2026-10-01T00:00:00.123456Z'", history(db)), "2").await?;
    let count = |k: &str| counts.get(k).copied().unwrap_or(0);
    if count("plan") != 2 || count("verified") != 2 || count("done") != 2 || count("statement") != count("applied") || count("statement") != c[0].1 + c[1].1 {
        return Err(format!("events {counts:?}"));
    }
    let mut again = 0;
    let mut record_again = |_: &ApplyEvent| -> Result<(), EventError> {
        again += 1;
        Ok(())
    };
    let result = run(conn, Command::Apply, plans, None, &mut record_again).await;
    if result.is_err() || again != 0 {
        return Err(format!("apply again: {result:?}, {again} events"));
    }
    Ok(())
}

async fn drift(conn: &mut Conn, plans: &[Plan]) -> Result<(), String> {
    run(conn, Command::Apply, &plans[..1], None, &mut quiet).await.map_err(|e| format!("apply: {e}"))?;
    conn.exec("CREATE TABLE extra (id integer PRIMARY KEY)").await?;
    let result = run(conn, Command::Apply, plans, None, &mut quiet).await;
    match code(&result) {
        Some("drift") => Ok(()),
        _ => Err(format!("apply after a change outside plans: {result:?}, want drift")),
    }
}

async fn lock(conn: &mut Conn, db: &str, plans: &[Plan], session: &Session) -> Result<(), String> {
    let mut other = session.open().await.map_err(|e| format!("session: {e}"))?;
    let hold = match db {
        "mysql" => format!("SELECT GET_LOCK({MYSQL_APPLY_LOCK}, 0)"),
        "postgres" => format!("SELECT pg_advisory_lock({POSTGRES_APPLY_LOCK})"),
        _ => "BEGIN IMMEDIATE".to_owned(),
    };
    let checked = async {
        other.exec(&hold).await.map_err(|e| format!("hold: {e}"))?;
        let result = run(conn, Command::Apply, plans, None, &mut quiet).await;
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

async fn other_database(conn: &mut Conn, db: &str, plans: &[Plan], target: &str, session: &Session) -> Result<(), String> {
    // While the apply on the first database holds the lock, the same chain is applied
    // to a second database, schema, or file. The lock covers only one database, so it is not locked.
    let second = session.second();
    match db {
        "mysql" => conn.exec(&format!("CREATE DATABASE `{}`", second.name())).await?,
        "postgres" => conn.exec(&format!("CREATE SCHEMA \"{}\"", second.name())).await?,
        _ => {}
    }
    let mut other = second.open().await.map_err(|e| format!("second session: {e}"))?;
    let checked = async {
        other.exec_all(&connection_rules(db).iter().map(|s| (*s).to_owned()).collect::<Vec<_>>()).await?;
        async fn under<C: ApplyConnection + Send>(
            c: &mut C,
            d: Dialect,
            other: &mut Conn,
            plans: &[Plan],
        ) -> (Result<(), ApplyError>, Option<Result<(), ApplyError>>) {
            let mut wrapped = ApplyOtherUnderLock { inner: c, other, plans, result: None };
            let result = apply(&mut wrapped, d, plans, &fixed_now, &mut quiet).await;
            (result, wrapped.result)
        }
        let (result, second_result) = match conn {
            Conn::MySql(c) => under(c, Dialect::MySql, &mut other, plans).await,
            Conn::Postgres(c) => under(c, Dialect::Postgres, &mut other, plans).await,
            Conn::Sqlite(c) => under(c, Dialect::Sqlite, &mut other, plans).await,
        };
        result.map_err(|e| format!("apply: {e}"))?;
        match second_result {
            Some(Ok(())) => {}
            other => return Err(format!("apply to {} while the first applies: {other:?}", second.name())),
        }
        schema_is(conn, target).await?;
        schema_is(&mut other, target).await
    }
    .await;
    let closed = other.close().await.map_err(|e| format!("close second session: {e}"));
    checked.and(closed)
}

async fn empty_chain(conn: &mut Conn, db: &str) -> Result<(), String> {
    // A chain with no plans applies nothing to a database that has no tables.
    let mut events = 0;
    let mut record = |_: &ApplyEvent| -> Result<(), EventError> {
        events += 1;
        Ok(())
    };
    for command in [Command::Apply, Command::Recover, Command::Rollback, Command::Finalize] {
        run(conn, command, &[], None, &mut record).await.map_err(|e| format!("the empty chain: {e}"))?;
    }
    if events != 0 {
        return Err(format!("the empty chain reported {events} events"));
    }
    schema_is(conn, "").await?;
    want(conn, &format!("SELECT COUNT(*) FROM {}", history(db)), "0").await?;
    conn.exec("CREATE TABLE extra (id integer PRIMARY KEY)").await?;
    let result = run(conn, Command::Apply, &[], None, &mut quiet).await;
    match code(&result) {
        Some("drift") => Ok(()),
        _ => Err(format!("apply of the empty chain to a database with a table: {result:?}, want drift")),
    }
}

async fn unlock_not_held(conn: &mut Conn, plans: &[Plan]) -> Result<(), String> {
    // If the advisory lock is released first, after the history table is created, the unlock at the end of the command
    // releases nothing.
    let result =
        run(conn, Command::Apply, plans, Some(("CREATE TABLE IF NOT EXISTS", &format!("SELECT pg_advisory_unlock({POSTGRES_APPLY_LOCK})"))), &mut quiet).await;
    let want = "the advisory lock of dbspec$plans was not held at unlock";
    match &result {
        Err(e) if e.to_string() == want => Ok(()),
        _ => Err(format!("apply after the lock was released by another statement: {result:?}, want {want:?}")),
    }
}

async fn verify_failure(conn: &mut Conn, db: &str, plans: &[Plan]) -> Result<(), String> {
    // If a table outside the plan is created after the last statement of the first plan, verification fails and the row
    // stays in applying with all steps recorded.
    let dialect = DIALECTS.iter().find(|(name, _)| *name == db).map(|(_, d)| *d).ok_or_else(|| format!("unknown database {db}"))?;
    let steps = plan_steps(None, &plans[0], dialect).map_err(|e| format!("steps: {e:?}"))?;
    let last = &steps.last().ok_or("the first plan has no step")?.statement;
    let result = run(conn, Command::Apply, plans, Some((last, "CREATE TABLE sneak (id integer PRIMARY KEY)")), &mut quiet).await;
    if code(&result) != Some("verify") {
        return Err(format!("apply with a table outside the plan: {result:?}, want verify"));
    }
    history_is(conn, db, &format!("{}|applying|{}", plans[0].name(), steps.len())).await
}

/// Rows written by an applied plan remain after rollback, and the values and defaults of dropped columns
/// come back; applying again brings back the values of added columns. A rollback after finalize
/// cannot be reverted.
async fn rows_between(conn: &mut Conn, db: &str, chain: &[Plan], c: &[(usize, usize)]) -> Result<(), String> {
    let (source, target) = (schema_text(&chain[0]), schema_text(&chain[1]));
    run(conn, Command::Apply, &chain[..1], None, &mut quiet).await.map_err(|e| format!("apply base: {e}"))?;
    conn.exec("INSERT INTO users (mail, legacy_code, age, nick) VALUES ('a@x', 7, 3, 'n1')").await?;
    run(conn, Command::Apply, chain, None, &mut quiet).await.map_err(|e| format!("apply: {e}"))?;
    conn.exec("INSERT INTO clients (email, age) VALUES ('b@x', 5)").await?;
    conn.exec("UPDATE clients SET status = 'vip' WHERE email = 'a@x'").await?;
    run(conn, Command::Rollback, chain, None, &mut quiet).await.map_err(|e| format!("rollback: {e}"))?;
    schema_is(conn, &source).await?;
    history_is(conn, db, &format!("base|applied|{}", c[0].1)).await?;
    rows_are(conn, "SELECT mail, legacy_code, nick FROM users ORDER BY mail", "a@x|7|n1,b@x|0|x").await?;
    run(conn, Command::Apply, chain, None, &mut quiet).await.map_err(|e| format!("apply again: {e}"))?;
    schema_is(conn, &target).await?;
    rows_are(conn, "SELECT email, status FROM clients ORDER BY email", "a@x|vip,b@x|new").await?;
    history_is(conn, db, &format!("base|applied|{},representative|applied|{}", c[0].1, c[1].1)).await?;
    run(conn, Command::Finalize, chain, None, &mut quiet).await.map_err(|e| format!("finalize: {e}"))?;
    history_is(conn, db, &format!("base|done|{},representative|done|{}", c[0].0, c[1].0)).await?;
    want(conn, hidden_left(db), "0").await?;
    schema_is(conn, &target).await?;
    let result = run(conn, Command::Rollback, chain, None, &mut quiet).await;
    if code(&result) != Some("irreversible") {
        return Err(format!("rollback of a finalized plan: {result:?}, want irreversible"));
    }
    schema_is(conn, &target).await
}

/// If a NULL row appears in the meantime in a hidden non-null column with no default, rollback
/// changes nothing and stops with a nulls error that states the row count.
async fn nulls(conn: &mut Conn, db: &str, chain: &[Plan], c: &[(usize, usize)]) -> Result<(), String> {
    run(conn, Command::Apply, chain, None, &mut quiet).await.map_err(|e| format!("apply: {e}"))?;
    conn.exec("INSERT INTO t (a) VALUES ('y')").await?;
    let result = run(conn, Command::Rollback, chain, None, &mut quiet).await;
    match &result {
        Err(e) if e.code() == Some("nulls") && e.to_string().contains("has 1 NULL rows") => {}
        _ => return Err(format!("rollback with a NULL row: {result:?}, want nulls with the count")),
    }
    schema_is(conn, &schema_text(&chain[1])).await?;
    history_is(conn, db, &format!("base|applied|{},drop_required_column|applied|{}", c[0].1, c[1].1)).await
}

/// Step k of the representative plan: apply stops after the statement, rolls back, then
/// stops, recovers, and stops the applied plan's rollback after the rollback statement of step k,
/// and continues the rollback.
async fn interrupt(conn: &mut Conn, db: &str, chain: &[Plan], c: &[(usize, usize)], k: usize) -> Result<(), String> {
    let (source, target) = (schema_text(&chain[0]), schema_text(&chain[1]));
    let name = chain[1].name().to_owned();
    let base = format!("base|applied|{}", c[0].1);
    run(conn, Command::Apply, &chain[..1], None, &mut quiet).await.map_err(|e| format!("apply base: {e}"))?;
    let result = run(conn, Command::Apply, chain, None, &mut stop_after(name.clone(), k)).await;
    if !stopped(&result) {
        return Err(format!("apply stopped by an event: {result:?}"));
    }
    history_is(conn, db, &format!("{base},representative|applying|{k}")).await?;
    let result = run(conn, Command::Apply, chain, None, &mut quiet).await;
    if code(&result) != Some("interrupted") {
        return Err(format!("apply over an interrupted plan: {result:?}, want interrupted"));
    }
    run(conn, Command::Rollback, chain, None, &mut quiet).await.map_err(|e| format!("rollback of the interrupted plan: {e}"))?;
    schema_is(conn, &source).await?;
    history_is(conn, db, &base).await?;
    let result = run(conn, Command::Apply, chain, None, &mut stop_after(name.clone(), k)).await;
    if !stopped(&result) {
        return Err(format!("apply stopped again: {result:?}"));
    }
    run(conn, Command::Recover, chain, None, &mut quiet).await.map_err(|e| format!("recover: {e}"))?;
    schema_is(conn, &target).await?;
    history_is(conn, db, &format!("{base},representative|applied|{}", c[1].1)).await?;
    let result = run(conn, Command::Rollback, chain, None, &mut stop_after(name, k)).await;
    if !stopped(&result) {
        return Err(format!("rollback stopped by an event: {result:?}"));
    }
    history_is(conn, db, &format!("{base},representative|rolling_back|{}", k + 1)).await?;
    run(conn, Command::Rollback, chain, None, &mut quiet).await.map_err(|e| format!("rollback continued: {e}"))?;
    schema_is(conn, &source).await?;
    history_is(conn, db, &base).await
}

/// The scenario name and its database.
const SCENARIOS: [(&str, &[&str]); 9] = [
    ("chain_history_and_again", &["mysql", "postgres", "sqlite"]),
    ("drift", &["mysql", "postgres", "sqlite"]),
    ("lock", &["mysql", "postgres", "sqlite"]),
    ("other_database", &["mysql", "postgres", "sqlite"]),
    ("empty_chain", &["mysql", "postgres", "sqlite"]),
    ("unlock_not_held", &["postgres"]),
    ("verify_failure", &["mysql", "postgres", "sqlite"]),
    ("rows_between", &["mysql", "postgres", "sqlite"]),
    ("nulls", &["mysql", "postgres", "sqlite"]),
];

#[tokio::test]
async fn apply_chain_on_three_databases() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let started = Instant::now();
    let plans = apply_chain();
    let target = dbspec::manifest(&[plans[1].schema()]).expect("target manifest").schema_text;
    let plan_counts = counts(&plans);
    let representative = case_chain("representative");
    let rep_counts = counts(&representative);
    let required = case_chain("drop-required-column");
    let required_counts = counts(&required);
    let mut runs_list: Vec<(String, &'static str, Option<usize>)> = Vec::new();
    for (scenario, dbs) in SCENARIOS {
        for &db in dbs {
            runs_list.push((scenario.to_owned(), db, None));
        }
    }
    for &(db, _) in DIALECTS.iter() {
        for k in 0..rep_counts[db][1].1 {
            runs_list.push((format!("interrupt_{k:02}"), db, Some(k)));
        }
    }
    let mut servers = Servers::open("apply").await;
    let mut failures = Vec::new();
    let mut runs = 0;
    for (scenario, db, k) in runs_list {
        runs += 1;
        let id = format!("{db}.apply.{scenario}");
        let session = servers.session(db, runs);
        // The probe body is a 'static future, so it takes copies of the chain and target.
        let (plans, target, representative, required) = (plans.clone(), target.clone(), representative.clone(), required.clone());
        let (pc, rc, qc) = (plan_counts[db].clone(), rep_counts[db].clone(), required_counts[db].clone());
        let result = run_probe(&mut servers, &id, db, runs, |conn| {
            Box::pin(async move {
                let (plans, target) = (plans.as_slice(), target.as_str());
                conn.exec_all(&connection_rules(db).iter().map(|s| (*s).to_owned()).collect::<Vec<_>>()).await?;
                if let Some(k) = k {
                    return interrupt(conn, db, &representative, &rc, k).await;
                }
                match scenario.as_str() {
                    "chain_history_and_again" => chain_history_and_again(conn, db, plans, target, &pc).await,
                    "drift" => drift(conn, plans).await,
                    "lock" => lock(conn, db, plans, &session).await,
                    "other_database" => other_database(conn, db, plans, target, &session).await,
                    "empty_chain" => empty_chain(conn, db).await,
                    "unlock_not_held" => unlock_not_held(conn, plans).await,
                    "verify_failure" => verify_failure(conn, db, plans).await,
                    "rows_between" => rows_between(conn, db, &representative, &rc).await,
                    "nulls" => nulls(conn, db, &required, &qc).await,
                    other => Err(format!("unknown scenario {other}")),
                }
            })
        })
        .await;
        if let Err(e) = result {
            failures.push(format!("{id}: {e}"));
        }
    }
    servers.close().await;
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
    let want = 25 + DIALECTS.iter().map(|(db, _)| rep_counts[db][1].1).sum::<usize>();
    assert_eq!(runs, want, "apply runs");
    polyspec_orm_testcase::step(format_args!("dbspec apply: {runs} runs on three databases in {:?}", started.elapsed()));
    // The apply scenarios for three databases finish within 1 minute on the development machine (41 s measured in T27, including build). Five minutes means it has stalled.
    if started.elapsed() >= Duration::from_secs(300) {
        polyspec_orm_testcase::warning(format_args!("apply exceeded 300s"));
    }
}

/// A connection with the database of the PgBouncer DSN replaced by `name`. The server connection behind the pooler
/// may change per statement, so the prepared statement cache is not used.
async fn pooler_connection(dsn: &str, name: &str) -> sqlx::PgConnection {
    use sqlx::Connection as _;
    let ConnectOptions::Postgres(options) = parse_dsn(dsn).expect("ORM_TEST_PGBOUNCER_DSN").options else {
        panic!("ORM_TEST_PGBOUNCER_DSN is not postgres://")
    };
    sqlx::PgConnection::connect_with(&options.database(name).statement_cache_capacity(0)).await.expect("connection through PgBouncer")
}

/// apply needs one server session, not shared with another client, from start to finish (docs/spec/plans.md
/// "Apply"). PgBouncer's transaction pooling picks a server connection again per statement, so apply
/// checks the server session at the lock and at each step, and stops with a session error. Each scenario
/// creates its own database and connects to it through PgBouncer. PgBouncer reuses idle server connections LIFO
/// (server_round_robin = 0), so the order below is fixed. An event handler is a synchronous function, so the
/// connection's transaction is opened by another task, and the handler waits for that task with block_in_place.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_through_a_transaction_pooler() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let server = require_dsn("ORM_TEST_POSTGRES_SERVER_DSN");
    let pooler = require_dsn("ORM_TEST_PGBOUNCER_DSN");
    let plans = apply_chain();
    let ConnectOptions::Postgres(admin_options) = parse_dsn(&server).expect("ORM_TEST_POSTGRES_SERVER_DSN").options else { panic!("not postgres://") };
    let mut admin = {
        use sqlx::Connection as _;
        sqlx::PgConnection::connect_with(&admin_options).await.expect("admin connection")
    };
    let mut failures = Vec::new();
    for scenario in ["lock_shared", "session_changed"] {
        let name = format!("orm_case_{}_pooler_{scenario}", std::process::id());
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE \"{name}\""))).execute(&mut admin).await.expect("create database");
        let mut apply_conn = pooler_connection(&pooler, &name).await;
        let other = std::sync::Arc::new(tokio::sync::Mutex::new(pooler_connection(&pooler, &name).await));
        let result = match scenario {
            // Apply takes over a server connection on which another client holds a session advisory lock.
            "lock_shared" => {
                let lock = format!("SELECT pg_advisory_lock({POSTGRES_APPLY_LOCK})");
                sqlx::raw_sql(sqlx::AssertSqlSafe(lock)).execute(&mut *other.lock().await).await.expect("hold the lock");
                apply(&mut apply_conn, Dialect::Postgres, &plans, &fixed_now, &mut quiet).await
            }
            // Before the first step, another client takes apply's server connection in a transaction, so apply's
            // next statement runs on a different server connection.
            _ => {
                let mut held = false;
                let handle = tokio::runtime::Handle::current();
                let holder = other.clone();
                let mut hold = move |event: &ApplyEvent| -> Result<(), EventError> {
                    if event.kind != ApplyEventKind::Statement || held {
                        return Ok(());
                    }
                    held = true;
                    let holder = holder.clone();
                    tokio::task::block_in_place(|| {
                        handle.block_on(async move {
                            let mut conn = holder.lock().await;
                            sqlx::raw_sql("BEGIN").execute(&mut *conn).await?;
                            sqlx::raw_sql("SELECT 1").execute(&mut *conn).await.map(drop)
                        })
                    })
                    .map_err(|e| Box::new(e) as EventError)
                };
                let result = apply(&mut apply_conn, Dialect::Postgres, &plans, &fixed_now, &mut hold).await;
                let _ = sqlx::raw_sql("ROLLBACK").execute(&mut *other.lock().await).await;
                result
            }
        };
        match &result {
            Err(e) if e.code() == Some("session") && e.to_string().contains("a direct or session-pooled connection") => {
                polyspec_orm_testcase::step(format_args!("{scenario}: {e}"));
            }
            other => failures.push(format!("{scenario}: apply through a transaction pooler: {other:?}, want a session error")),
        }
        drop(apply_conn);
        drop(other);
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP DATABASE \"{name}\" WITH (FORCE)"))).execute(&mut admin).await.expect("drop database");
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
