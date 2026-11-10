//! The ops of the dbspec apply API (docs/spec/feature-coverage.md FCV-4): each command is one call of the public API on a named
//! connection, and steps nested in its on field run inside the event handler. The handler is a synchronous function and the
//! command borrows its connection, so the ops run on a multi-thread runtime of their own, where the handler waits for a nested
//! step with block_in_place, and a step nested on the connection of the command takes that connection between two statements of
//! the command.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;

use polyspec_orm::db::{parse_dsn, ConnectOptions};
use polyspec_orm::dbspec::{self, ApplyConnection, ApplyError, ApplyEvent, ApplyEventError, CatalogQuerier, CatalogValue, Dialect, Plan, Server};
use polyspec_orm_case_database::CaseDatabase;
use serde_json::{json, Value};
use sqlx::{Connection as _, MySqlConnection, PgConnection, SqliteConnection};
use tokio::runtime::{Handle, Runtime};
use tokio::sync::Mutex;

/// The ops that [`ApplyOps::run`] takes.
pub const OPS: [&str; 9] = [
    "dbspec.plan",
    "dbspec.connect",
    "dbspec.exec",
    "dbspec.schema",
    "dbspec.other_database",
    "dbspec.apply",
    "dbspec.recover",
    "dbspec.rollback",
    "dbspec.finalize",
];

/// The fixed clock of the commands, 2023-11-14T22:13:20Z.
fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::from_timestamp(1_700_000_000, 0).expect("the fixed time is in range")
}

/// What an on with stop returns from the event handler, so the code of the command is stopped.
#[derive(Debug)]
struct Stop;

impl std::fmt::Display for Stop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the recipe stops the command")
    }
}

impl std::error::Error for Stop {}

/// A named connection.
enum Conn {
    MySql(MySqlConnection),
    Postgres(PgConnection),
    Sqlite(SqliteConnection),
    /// The session of a flowmark corpus, whose statements are in SQLite's dialect (DIA-185).
    Markdown(polyspec_orm::markdown::MarkdownLease),
}

impl Conn {
    async fn close(self) -> Result<(), String> {
        match self {
            Conn::MySql(c) => c.close().await,
            Conn::Postgres(c) => c.close().await,
            Conn::Sqlite(c) => c.close().await,
            // The session closes when its lease drops, instead of returning to the pool.
            Conn::Markdown(mut c) => {
                c.discard();
                Ok(())
            }
        }
        .map_err(|e| e.to_string())
    }
}

impl CatalogQuerier for Conn {
    async fn rows(&mut self, query: &str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        match self {
            Conn::MySql(c) => CatalogQuerier::rows(c, query).await,
            Conn::Postgres(c) => CatalogQuerier::rows(c, query).await,
            Conn::Sqlite(c) => CatalogQuerier::rows(c, query).await,
            Conn::Markdown(c) => CatalogQuerier::rows(c, query).await,
        }
    }
}

impl ApplyConnection for Conn {
    async fn execute(&mut self, statement: &str) -> Result<(), sqlx::Error> {
        match self {
            Conn::MySql(c) => ApplyConnection::execute(c, statement).await,
            Conn::Postgres(c) => ApplyConnection::execute(c, statement).await,
            Conn::Sqlite(c) => ApplyConnection::execute(c, statement).await,
            Conn::Markdown(c) => ApplyConnection::execute(c, statement).await,
        }
    }

    async fn execute_bound(&mut self, statement: &str, args: &[CatalogValue]) -> Result<(), sqlx::Error> {
        match self {
            Conn::MySql(c) => ApplyConnection::execute_bound(c, statement, args).await,
            Conn::Postgres(c) => ApplyConnection::execute_bound(c, statement, args).await,
            Conn::Sqlite(c) => ApplyConnection::execute_bound(c, statement, args).await,
            Conn::Markdown(c) => ApplyConnection::execute_bound(c, statement, args).await,
        }
    }

    async fn query_bound(&mut self, query: &str, args: &[CatalogValue]) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        match self {
            Conn::MySql(c) => ApplyConnection::query_bound(c, query, args).await,
            Conn::Postgres(c) => ApplyConnection::query_bound(c, query, args).await,
            Conn::Sqlite(c) => ApplyConnection::query_bound(c, query, args).await,
            Conn::Markdown(c) => ApplyConnection::query_bound(c, query, args).await,
        }
    }
}

/// The connection of a running command, shared with its event handler. The command holds the lock only while a statement runs,
/// and it calls the handler between statements, so a step nested on this connection reads what the command has done so far.
struct Shared {
    inner: Arc<Mutex<Conn>>,
}

impl CatalogQuerier for Shared {
    async fn rows(&mut self, query: &str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        let mut session = self.inner.lock().await;
        CatalogQuerier::rows(&mut *session, query).await
    }
}

impl ApplyConnection for Shared {
    async fn execute(&mut self, statement: &str) -> Result<(), sqlx::Error> {
        let mut session = self.inner.lock().await;
        ApplyConnection::execute(&mut *session, statement).await
    }

    async fn execute_bound(&mut self, statement: &str, args: &[CatalogValue]) -> Result<(), sqlx::Error> {
        let mut session = self.inner.lock().await;
        ApplyConnection::execute_bound(&mut *session, statement, args).await
    }

    async fn query_bound(&mut self, query: &str, args: &[CatalogValue]) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        let mut session = self.inner.lock().await;
        ApplyConnection::query_bound(&mut *session, query, args).await
    }
}

/// The named plans and connections of a case, and the step of the event that nested steps read.
#[derive(Default)]
struct State {
    plans: HashMap<String, Plan>,
    sessions: HashMap<String, Conn>,
    step: usize,
    /// Whether the case runs on MariaDB, a server of the MySQL dialect whose direct server is its own (DIA-200, FCV-3).
    mariadb: bool,
}

/// The apply ops of one case; [`ApplyOps::close`] ends its connections before the case database is dropped.
#[derive(Default)]
pub struct ApplyOps {
    runtime: Option<Runtime>,
    state: State,
}

impl ApplyOps {
    /// Runs one op of [`OPS`]; the result holds the value that its expect compares.
    pub fn run(&mut self, step: &Value, database: &str, dsn: &str) -> Result<Value, String> {
        if self.runtime.is_none() {
            let built = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().map_err(|e| e.to_string())?;
            self.runtime = Some(built);
        }
        let runtime = self.runtime.as_ref().ok_or("the runtime of the apply ops")?;
        self.state.mariadb = database == "mariadb";
        let state = &mut self.state;
        // A corpus runs the statements of SQLite and reads its entries (DIA-185); its DSN names the corpus.
        let database = match database {
            "markdown" => "sqlite",
            // MariaDB is a server of the MySQL dialect (DIA-200).
            "mariadb" => "mysql",
            other => other,
        };
        // The case runs on a runtime of its own, and a runtime starts no other inside it, so the op has a thread.
        std::thread::scope(|scope| {
            scope.spawn(|| runtime.block_on(run_op(state, step, database, dsn))).join().map_err(|panic| crate::recipe::panicked("an apply op", &*panic))?
        })
    }

    /// Closes the connections of the case; a failure names the first that did not close.
    pub fn close(&mut self) -> Result<(), String> {
        let Some(runtime) = self.runtime.take() else { return Ok(()) };
        let sessions: Vec<Conn> = self.state.sessions.drain().map(|(_, session)| session).collect();
        let closed = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    runtime.block_on(async {
                        let mut first = Ok(());
                        for session in sessions {
                            let closed = session.close().await;
                            if first.is_ok() {
                                first = closed;
                            }
                        }
                        first
                    })
                })
                .join()
                .map_err(|panic| crate::recipe::panicked("closing an apply connection", &*panic))?
        });
        runtime.shutdown_background();
        closed
    }
}

fn required(name: &str) -> Result<String, String> {
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => Ok(value),
        _ => Err(format!("{name} is required; run make orm-test-servers, which starts the databases and writes it")),
    }
}

fn dialect_of(database: &str) -> Result<Dialect, String> {
    match database {
        "mysql" => Ok(Dialect::MySql),
        "postgres" => Ok(Dialect::Postgres),
        "sqlite" => Ok(Dialect::Sqlite),
        other => Err(format!("unknown database {other}")),
    }
}

/// The server of the case database that the public dbspec calls take (DIA-203): MariaDB on a case of MariaDB, and the
/// server of the dialect's own database otherwise; a markdown corpus, already read as sqlite, answers in SQLite's dialect, as
/// its server.
fn server_of(database: &str, mariadb: bool) -> Result<Server, String> {
    match (dialect_of(database)?, mariadb) {
        (Dialect::MySql, true) => Ok(Server::MariaDb),
        (Dialect::MySql, false) => Ok(Server::MySql),
        (Dialect::Postgres, _) => Ok(Server::Postgres),
        (Dialect::Sqlite, _) => Ok(Server::Sqlite),
    }
}

/// The database name of a case DSN.
fn name_of(dsn: &str) -> &str {
    let path = dsn.split('?').next().unwrap_or(dsn);
    path.rsplit('/').next().unwrap_or(path)
}

/// The direct connection to the database of the case DSN, with the rules of a new connection.
async fn direct(database: &str, mariadb: bool, dsn: &str) -> Result<Conn, String> {
    let name = name_of(dsn);
    let (mut session, rule) = match database {
        "mysql" => {
            let variable = if mariadb { "ORM_TEST_MARIADB_SERVER_DSN" } else { "ORM_TEST_MYSQL_SERVER_DSN" };
            let server = required(variable)?;
            let ConnectOptions::MySql(options) = parse_dsn(&server).map_err(|e| e.to_string())?.options else {
                return Err(format!("{variable} is not mysql://"));
            };
            let connection = MySqlConnection::connect_with(&options.database(name)).await.map_err(|e| e.to_string())?;
            (Conn::MySql(connection), "SET time_zone = '+00:00'")
        }
        "postgres" => {
            let server = required("ORM_TEST_POSTGRES_SERVER_DSN")?;
            let ConnectOptions::Postgres(options) = parse_dsn(&server).map_err(|e| e.to_string())?.options else {
                return Err("ORM_TEST_POSTGRES_SERVER_DSN is not postgres://".to_owned());
            };
            let connection = PgConnection::connect_with(&options.database(name)).await.map_err(|e| e.to_string())?;
            (Conn::Postgres(connection), "SET TimeZone = 'UTC'")
        }
        _ => match parse_dsn(dsn).map_err(|e| e.to_string())?.options {
            ConnectOptions::Sqlite(options) => {
                let connection = SqliteConnection::connect_with(&options).await.map_err(|e| e.to_string())?;
                (Conn::Sqlite(connection), "PRAGMA foreign_keys = ON")
            }
            // A corpus: one session of its flowmark server, which holds the pool of the session.
            ConnectOptions::Markdown(options) => {
                let pool = polyspec_orm::markdown::MarkdownPool::connect(options, 1).await.map_err(|e| e.to_string())?;
                (Conn::Markdown(pool.acquire().await.map_err(|e| e.to_string())?), "PRAGMA foreign_keys = ON")
            }
            _ => return Err(format!("{dsn} is not sqlite:// or markdown://")),
        },
    };
    ApplyConnection::execute(&mut session, rule).await.map_err(|e| format!("{rule}: {e}"))?;
    Ok(session)
}

/// The connection through the transaction pooler (PLN-105), with no statement cache: a server connection behind the pooler can
/// change with each statement.
async fn through_pooler(dsn: &str) -> Result<Conn, String> {
    let pooler = required("ORM_TEST_PGBOUNCER_DSN")?;
    let ConnectOptions::Postgres(options) = parse_dsn(&pooler).map_err(|e| e.to_string())?.options else {
        return Err("ORM_TEST_PGBOUNCER_DSN is not postgres://".to_owned());
    };
    PgConnection::connect_with(&options.database(name_of(dsn)).statement_cache_capacity(0)).await.map(Conn::Postgres).map_err(|e| e.to_string())
}

/// The text of a step field that holds SQL: the string itself, or the entry of the database.
fn sql_of(step: &Value, database: &str, event_step: usize) -> Result<String, String> {
    let field = &crate::recipe_reads::read(step, "sql")["sql"];
    let text = field.as_str().or_else(|| field[database].as_str()).ok_or_else(|| format!("no statement for {database}: {step}"))?;
    Ok(text.replace("{step}", &event_step.to_string()))
}

fn cell(value: &CatalogValue) -> Value {
    match value {
        CatalogValue::Null => json!({ "null": true }),
        CatalogValue::Text(text) => json!({ "text": text }),
        CatalogValue::Int(number) => json!({ "text": number.to_string() }),
        CatalogValue::Bool(flag) => json!({ "text": flag.to_string() }),
    }
}

fn skipped(step: &Value, database: &str) -> bool {
    crate::recipe_reads::read(step, "only")["only"].as_array().is_some_and(|only| !only.iter().any(|name| name.as_str() == Some(database)))
}

/// Compares the value of a nested step with its expect; the steps of a case are compared by the helper.
fn checked(step: &Value, database: &str, got: &Value) -> Result<(), String> {
    match crate::recipe_reads::read(step, "expect").get("expect") {
        Some(expect) if expect[database]["value"] != got["value"] => Err(format!("got {}, want {}", got["value"], expect[database]["value"])),
        _ => Ok(()),
    }
}

/// Runs the statement of dbspec.exec on its connection; its value is the rows, when the step expects them.
async fn exec_on(session: &mut Conn, step: &Value, text: &str) -> Result<Value, String> {
    if crate::recipe_reads::read(step, "expect").get("expect").is_none() {
        ApplyConnection::execute(session, text).await.map_err(|e| format!("{text}: {e}"))?;
        return Ok(json!({}));
    }
    let rows = ApplyConnection::query_bound(session, text, &[]).await.map_err(|e| format!("{text}: {e}"))?;
    let array: Vec<Value> = rows.iter().map(|row| json!({ "array": row.iter().map(cell).collect::<Vec<_>>() })).collect();
    Ok(json!({ "value": { "array": array } }))
}

type OpFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + 'a>>;

fn run_op<'a>(state: &'a mut State, step: &'a Value, database: &'a str, dsn: &'a str) -> OpFuture<'a> {
    Box::pin(op_body(state, step, database, dsn))
}

async fn op_body(state: &mut State, step: &Value, database: &str, dsn: &str) -> Result<Value, String> {
    let name = crate::recipe_reads::read(step, "as")["as"].as_str().unwrap_or_default();
    match crate::recipe_reads::read(step, "op")["op"].as_str().unwrap_or_default() {
        "dbspec.plan" => {
            let lines: Vec<&str> = crate::recipe_reads::read(step, "lines")["lines"].as_array().ok_or("lines")?.iter().filter_map(Value::as_str).collect();
            let plan = dbspec::parse_plan(&format!("{}\n", lines.join("\n"))).map_err(|d| format!("dbspec.plan {name}: {d:?}"))?;
            state.plans.insert(name.to_owned(), plan);
            Ok(json!({}))
        }
        "dbspec.connect" => {
            let session = if crate::recipe_reads::read(step, "through")["through"] == "pooler" {
                through_pooler(dsn).await?
            } else {
                direct(database, state.mariadb, dsn).await?
            };
            state.sessions.insert(name.to_owned(), session);
            Ok(json!({}))
        }
        "dbspec.exec" => {
            let text = sql_of(step, database, state.step)?;
            let connection = crate::recipe_reads::read(step, "connection")["connection"].as_str().unwrap_or_default();
            let session = state.sessions.get_mut(connection).ok_or_else(|| format!("connection {connection} is not bound"))?;
            exec_on(session, step, &text).await
        }
        "dbspec.schema" => {
            let connection = crate::recipe_reads::read(step, "connection")["connection"].as_str().unwrap_or_default();
            let session = state.sessions.get_mut(connection).ok_or_else(|| format!("connection {connection} is not bound"))?;
            let introspection =
                dbspec::introspect(session, dialect_of(database)?, server_of(database, state.mariadb)?, "x").await.map_err(|e| format!("introspect: {e}"))?;
            if !introspection.unsupported.is_empty() {
                return Err(format!("dbspec.schema: unsupported {:?}", introspection.unsupported));
            }
            let text = if introspection.document.tables.is_empty() {
                String::new()
            } else {
                dbspec::manifest(&[&introspection.document]).map_err(|e| format!("manifest: {e:?}"))?.schema_text
            };
            Ok(json!({ "value": { "text": text } }))
        }
        // On a corpus the other database is a new corpus, with no table.
        "dbspec.other_database" if dsn.starts_with("markdown://") => {
            let other = crate::markdown::case_corpus(None).await;
            let result = other_steps(state, step, database, &other.dsn).await;
            drop(other);
            result.map(|()| json!({}))
        }
        "dbspec.other_database" => {
            // The other database is on the server of the case, which direct connects to: MariaDB's own on MariaDB (DIA-200).
            let other = CaseDatabase::create(if state.mariadb { "mariadb" } else { database }).await;
            let result = other_steps(state, step, database, other.dsn()).await;
            other.drop().await;
            result.map(|()| json!({}))
        }
        _ => command(state, step, database, dsn).await,
    }
}

/// The nested steps of dbspec.other_database, on a new connection to the other database that ends with them.
async fn other_steps(state: &mut State, step: &Value, database: &str, other: &str) -> Result<(), String> {
    let name = crate::recipe_reads::read(step, "as")["as"].as_str().unwrap_or_default();
    state.sessions.insert(name.to_owned(), direct(database, state.mariadb, other).await?);
    let mut result = Ok(());
    for nested in crate::recipe_reads::read(step, "steps")["steps"].as_array().into_iter().flatten() {
        if skipped(nested, database) {
            continue;
        }
        result = match run_op(state, nested, database, other).await {
            Ok(got) => checked(nested, database, &got),
            Err(failure) => Err(failure),
        };
        if result.is_err() {
            break;
        }
    }
    if let Some(session) = state.sessions.remove(name) {
        let closed = session.close().await;
        if result.is_ok() {
            result = closed;
        }
    }
    result
}

/// The failure that a cleanup failure followed, which holds the code of the command.
fn first_failure(error: &ApplyError) -> &ApplyError {
    match error {
        ApplyError::Cleanup { error, .. } => first_failure(error),
        other => other,
    }
}

thread_local! {
    /// The step guard of the case with a step deadline that runs on this thread (each case runs on a thread of its own).
    static STALL: std::cell::RefCell<Option<std::sync::Arc<polyspec_orm_testcase::StepGuard>>> = const { std::cell::RefCell::new(None) };
}

/// Sets, or with None clears, the step guard of the case that runs on this thread.
pub(crate) fn guard_case(guard: Option<std::sync::Arc<polyspec_orm_testcase::StepGuard>>) {
    STALL.with(|stall| *stall.borrow_mut() = guard);
}

/// Records an apply event of the case that runs on this thread: it restarts the stall limit of its step guard, if it has one.
fn progressed() {
    STALL.with(|stall| {
        if let Some(guard) = stall.borrow().as_ref() {
            guard.progressed();
        }
    });
}

/// Makes one call of the command; its value is the code of its failure, or ok, and the events that count names.
async fn command(state: &mut State, step: &Value, database: &str, dsn: &str) -> Result<Value, String> {
    let dialect = dialect_of(database)?;
    let server = server_of(database, state.mariadb)?;
    let target = crate::recipe_reads::read(step, "connection")["connection"].as_str().unwrap_or_default().to_owned();
    let mut plans: Vec<Plan> = Vec::new();
    for name in crate::recipe_reads::read(step, "plans")["plans"].as_array().ok_or("plans")?.iter().filter_map(Value::as_str) {
        plans.push(state.plans.get(name).cloned().ok_or_else(|| format!("plan {name} is not bound"))?);
    }
    // The command borrows its connection, so it is out of the map while the nested steps reach the others.
    let session = state.sessions.remove(&target).ok_or_else(|| format!("connection {target} is not bound"))?;
    let shared = Arc::new(Mutex::new(session));
    let on = crate::recipe_reads::read(step, "on").get("on");
    let mut kinds: HashMap<String, u64> = HashMap::new();
    let mut events = 0_u64;
    let mut ran = false;
    let started = Instant::now();
    let result = {
        let nested_session = Arc::clone(&shared);
        let mut handler = |event: &ApplyEvent| -> Result<(), ApplyEventError> {
            progressed();
            events += 1;
            *kinds.entry(event.kind.as_str().to_owned()).or_default() += 1;
            let Some(on) = on else { return Ok(()) };
            if on["event"].as_str() != Some(event.kind.as_str()) || (ran && on["every"].as_bool() != Some(true)) {
                return Ok(());
            }
            let step = u64::try_from(event.step)?;
            if on.get("plan").is_some_and(|plan| plan.as_str() != Some(event.plan.as_str())) || on.get("step").is_some_and(|at| at.as_u64() != Some(step)) {
                return Ok(());
            }
            ran = true;
            state.step = event.step;
            for nested in on["steps"].as_array().into_iter().flatten() {
                if skipped(nested, database) {
                    continue;
                }
                if nested["op"] == "dbspec.exec" && nested["connection"].as_str() == Some(target.as_str()) {
                    let text = sql_of(nested, database, state.step)?;
                    let got = tokio::task::block_in_place(|| {
                        Handle::current().block_on(async {
                            let mut session = nested_session.lock().await;
                            exec_on(&mut session, nested, &text).await
                        })
                    })?;
                    checked(nested, database, &got)?;
                    continue;
                }
                let got = tokio::task::block_in_place(|| Handle::current().block_on(run_op(&mut *state, nested, database, dsn)))?;
                checked(nested, database, &got)?;
            }
            if on["stop"].as_bool() == Some(true) {
                return Err(Box::new(Stop));
            }
            Ok(())
        };
        let mut connection = Shared { inner: Arc::clone(&shared) };
        match crate::recipe_reads::read(step, "op")["op"].as_str().unwrap_or_default() {
            "dbspec.apply" => dbspec::apply(&mut connection, dialect, server, &plans, &now, &mut handler).await,
            "dbspec.recover" => dbspec::recover(&mut connection, dialect, server, &plans, &now, &mut handler).await,
            "dbspec.rollback" => dbspec::rollback(&mut connection, dialect, server, &plans, &now, &mut handler).await,
            "dbspec.finalize" => dbspec::finalize(&mut connection, dialect, server, &plans, &now, &mut handler).await,
            other => return Err(format!("OP_UNKNOWN {other}")),
        }
    };
    let elapsed = started.elapsed().as_millis();
    let session = Arc::into_inner(shared).ok_or("the connection of the command is still held")?.into_inner();
    state.sessions.insert(target, session);
    let code = match &result {
        Ok(()) => "ok".to_owned(),
        Err(error) => {
            let failure = first_failure(error);
            let message = failure.to_string();
            let code = match failure {
                ApplyError::Event(stop) if stop.is::<Stop>() => "stopped".to_owned(),
                other => match other.code() {
                    Some(code) => code.to_owned(),
                    None if crate::recipe_reads::read(step, "message")["message"].as_str() == Some(message.as_str()) => "message".to_owned(),
                    None => return Err(format!("{}: {message}", crate::recipe_reads::read(step, "op")["op"])),
                },
            };
            if let Some(detail) = crate::recipe_reads::read(step, "detail")["detail"].as_str() {
                if !message.to_lowercase().contains(&detail.to_lowercase()) {
                    return Err(format!("the message {message:?} does not hold {detail:?}"));
                }
            }
            code
        }
    };
    if let Some(bounds) = crate::recipe_reads::read(step, "elapsed").get("elapsed") {
        let (least, below) = (bounds["at_least_ms"].as_u64().unwrap_or(0), bounds["below_ms"].as_u64().unwrap_or(0));
        if elapsed < u128::from(least) || elapsed >= u128::from(below) {
            return Err(format!("the command took {elapsed} ms, want at least {least} and below {below}"));
        }
    }
    let mut members = vec![json!(["code", { "text": code }])];
    match crate::recipe_reads::read(step, "count")["count"].as_array() {
        None => members.push(json!(["events", { "int": events.to_string() }])),
        Some(counted) => {
            for kind in counted.iter().filter_map(Value::as_str) {
                members.push(json!([kind, { "int": kinds.get(kind).copied().unwrap_or(0).to_string() }]));
            }
        }
    }
    Ok(json!({ "value": { "object": members } }))
}
