//! Applying plan chains step by step (docs/spec/plans.md, "Apply"): [`apply`]
//! runs the steps of the plans of a chain that the database has not applied,
//! each statement on its own with its recorded history step in the table
//! `dbspec$plans`, and verifies each plan by introspection; [`recover`]
//! continues an interrupted plan from the catalog effect of the step after
//! its recorded one; [`rollback`] undoes the last plan with its rollback
//! statements; [`finalize`] drops what the applied plans hid.

use super::{CatalogQuerier, CatalogValue, Dialect, Effect, IntrospectError, Plan, PlanStep, chain, introspect, manifest, plan_steps};
use chrono::{DateTime, Utc};
use sqlx::{AssertSqlSafe, MySqlConnection, PgConnection, SqliteConnection};
use std::future::Future;

/// The connection that the commands run on: it runs statements and reads
/// the catalog. The sqlx MySQL, PostgreSQL and SQLite connections implement
/// it; the commands use their lock and session settings only on this
/// connection.
pub trait ApplyConnection: CatalogQuerier {
    /// Runs one statement without bound values.
    fn execute(&mut self, statement: &str) -> impl Future<Output = Result<(), sqlx::Error>> + Send;
    /// Runs one statement with its bound values in placeholder order.
    fn execute_bound(&mut self, statement: &str, args: &[CatalogValue]) -> impl Future<Output = Result<(), sqlx::Error>> + Send;
    /// Runs one query with its bound values and returns its rows.
    fn query_bound(&mut self, query: &str, args: &[CatalogValue]) -> impl Future<Output = Result<Vec<Vec<CatalogValue>>, sqlx::Error>> + Send;
}

/// The kind of an [`ApplyEvent`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyEventKind {
    /// Apply or recover runs a plan forward; `steps` is its number of steps.
    Plan,
    /// A rollback starts on a plan.
    Rollback,
    /// A finalize starts on a plan.
    Finalize,
    /// Step `step` has no rollback statement.
    Irreversible,
    /// The statement or rollback statement of step `step` is about to run.
    Statement,
    /// The statement or rollback statement of step `step` ran.
    Applied,
    /// The plan's schema is verified.
    Verified,
    /// The plan reached its state.
    Done,
}

impl ApplyEventKind {
    /// The event name of docs/spec/plans.md.
    pub fn as_str(self) -> &'static str {
        match self {
            ApplyEventKind::Plan => "plan",
            ApplyEventKind::Rollback => "rollback",
            ApplyEventKind::Finalize => "finalize",
            ApplyEventKind::Irreversible => "irreversible",
            ApplyEventKind::Statement => "statement",
            ApplyEventKind::Applied => "applied",
            ApplyEventKind::Verified => "verified",
            ApplyEventKind::Done => "done",
        }
    }
}

/// One occurrence that a command reports (docs/spec/plans.md, "Apply"). `step`
/// and `statement` belong to the step events; the others carry 0 and an
/// empty statement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplyEvent {
    pub kind: ApplyEventKind,
    pub plan: String,
    pub step: usize,
    pub steps: usize,
    pub statement: String,
}

/// The error that an event handler returns to stop a command.
pub type ApplyEventError = Box<dyn std::error::Error + Send + Sync>;

/// The failure of [`apply`], [`recover`], [`rollback`] and [`finalize`]. The
/// coded failures of docs/spec/plans.md carry their code through
/// [`ApplyError::code`]: locked, session, interrupted, drift, chain, failed, verify,
/// irreversible and nulls.
#[derive(Debug)]
pub enum ApplyError {
    /// Another session holds the lock; nothing changed.
    Locked { message: String, source: Option<sqlx::Error> },
    /// The connection does not keep one server session of its own for the
    /// whole command: the session that took the lock already held it, or a
    /// later statement ran in another session. `plan` and `step` name the
    /// step before which the session changed; `None` is the lock.
    Session { plan: Option<(String, usize)>, message: String },
    /// The last plan of the history is applying, finalizing or rolling back
    /// at `step`.
    Interrupted { plan: String, step: usize, message: String },
    /// The database is not at the state that its history records.
    Drift { message: String },
    /// The plans do not form a chain, or the history does not match it.
    Chain { plan: Option<String>, message: String },
    /// The statement of step `step` of plan `plan` failed, or its effect
    /// could not be read.
    Failed { plan: String, step: usize, statement: String, source: sqlx::Error },
    /// The applied or rolled back database is not the plan's schema.
    Verify { plan: String, message: String, source: Option<IntrospectError> },
    /// Step `step` has no rollback statement; the rollback stopped before it.
    Irreversible { plan: String, step: usize, message: String },
    /// A column that the rollback of step `step` makes non-null has NULL rows
    /// and no default; nothing changed.
    Nulls { plan: String, step: usize, message: String },
    /// A history, lock or setting statement failed.
    Database(sqlx::Error),
    /// An event handler stopped the command.
    Event(ApplyEventError),
    /// Releasing the PostgreSQL advisory lock released nothing: the session no
    /// longer held it.
    LockNotHeld { message: String },
    /// Restoring the session settings or SQLite foreign keys, or releasing
    /// the lock, failed with `cleanup` after `error`. A second cleanup
    /// failure wraps this one again, so the chain of `error` lists the
    /// failures in order.
    Cleanup { error: Box<ApplyError>, cleanup: Box<ApplyError> },
}

impl ApplyError {
    /// The code of docs/spec/plans.md, or `None` for a database or event error.
    /// A cleanup failure has the code of the error it followed.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            ApplyError::Locked { .. } => Some("locked"),
            ApplyError::Session { .. } => Some("session"),
            ApplyError::Interrupted { .. } => Some("interrupted"),
            ApplyError::Drift { .. } => Some("drift"),
            ApplyError::Chain { .. } => Some("chain"),
            ApplyError::Failed { .. } => Some("failed"),
            ApplyError::Verify { .. } => Some("verify"),
            ApplyError::Irreversible { .. } => Some("irreversible"),
            ApplyError::Nulls { .. } => Some("nulls"),
            ApplyError::Database(_) | ApplyError::Event(_) | ApplyError::LockNotHeld { .. } => None,
            ApplyError::Cleanup { error, .. } => error.code(),
        }
    }
}

impl std::fmt::Display for ApplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApplyError::Locked { message, source: None } => write!(f, "locked: {message}"),
            ApplyError::Locked { message, source: Some(e) } => write!(f, "locked: {message}: {e}"),
            ApplyError::Session { plan: None, message } => write!(f, "session: {message}"),
            ApplyError::Session { plan: Some((plan, step)), message } => write!(f, "session {plan} at step {step}: {message}"),
            ApplyError::Interrupted { plan, step, message } => write!(f, "interrupted {plan} at step {step}: {message}"),
            ApplyError::Drift { message } => write!(f, "drift: {message}"),
            ApplyError::Chain { plan: None, message } => write!(f, "chain: {message}"),
            ApplyError::Chain { plan: Some(plan), message } => write!(f, "chain {plan}: {message}"),
            ApplyError::Failed { plan, step, statement, source } if statement.is_empty() => write!(f, "failed {plan} at step {step}: {source}"),
            ApplyError::Failed { plan, step, statement, source } => write!(f, "failed {plan} at step {step}: {statement}: {source}"),
            ApplyError::Verify { plan, message, .. } => write!(f, "verify {plan}: {message}"),
            ApplyError::Irreversible { plan, step, message } => write!(f, "irreversible {plan} at step {step}: {message}"),
            ApplyError::Nulls { plan, step, message } => write!(f, "nulls {plan} at step {step}: {message}"),
            ApplyError::Database(e) => write!(f, "{e}"),
            ApplyError::Event(e) => write!(f, "{e}"),
            ApplyError::LockNotHeld { message } => write!(f, "{message}"),
            ApplyError::Cleanup { error, cleanup } => write!(f, "{error}; then {cleanup}"),
        }
    }
}

impl std::error::Error for ApplyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ApplyError::Locked { source: Some(e), .. } | ApplyError::Failed { source: e, .. } | ApplyError::Database(e) => Some(e),
            ApplyError::Verify { source: Some(e), .. } => Some(e),
            ApplyError::Event(e) => Some(e.as_ref()),
            ApplyError::Cleanup { error, .. } => Some(error.as_ref()),
            _ => None,
        }
    }
}

#[derive(Debug)]
enum VerifyError {
    Mismatch(String),
    Introspection(IntrospectError),
}

fn verification_error(plan: String, error: VerifyError) -> ApplyError {
    match error {
        VerifyError::Mismatch(message) => ApplyError::Verify { plan, message, source: None },
        VerifyError::Introspection(source) => ApplyError::Verify { plan, message: source.to_string(), source: Some(source) },
    }
}

fn drift_or_verification_error(plan: Option<String>, error: VerifyError) -> ApplyError {
    match error {
        VerifyError::Mismatch(message) => ApplyError::Drift { message },
        other => verification_error(plan.unwrap_or_default(), other),
    }
}

impl From<sqlx::Error> for ApplyError {
    fn from(e: sqlx::Error) -> Self {
        ApplyError::Database(e)
    }
}

/// The table that records applied plans. Since dbspec names have no `$`, it does not
/// collide with user tables, and introspection reads while excluding tables that start with `dbspec$`.
const HISTORY_TABLE: &str = "dbspec$plans";
const HISTORY_COLUMNS: [&str; 7] = ["name", "from_hash", "to_hash", "state", "step", "steps", "applied_at"];

/// The lock name for the current database. MySQL lock names are up to 64 characters, so
/// instead of the database name, the first 51 characters of its SHA-256 hex are appended to make 64 characters.
const MYSQL_LOCK: &str = "CONCAT('dbspec$plans$', LEFT(SHA2(DATABASE(), 256), 51))";

/// The advisory lock key for the current schema of the current database.
const POSTGRES_LOCK: &str = "hashtext('dbspec$plans'), hashtext(current_schema())";

/// The requirement that a session error reveals. A lock belongs to a server session, so the command must run from start to finish on a
/// server session that is not shared with another client. A transaction pooler
/// picks a server connection again for each statement, so it cannot meet that requirement.
const SESSION_REQUIREMENT: &str =
    "apply, recover, rollback and finalize need one server session of their own for the whole run: a direct or session-pooled connection";

/// A query that reads the current server session's id and whether that session already holds this command's lock.
/// If the lock is already held before taking it, another client is using the same server session.
fn session_query(d: Dialect) -> String {
    match d {
        Dialect::MySql => format!("SELECT CONNECTION_ID(), COALESCE(IS_USED_LOCK({MYSQL_LOCK}) = CONNECTION_ID(), 0)"),
        _ => format!(
            "SELECT pg_backend_pid(), EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND objsubid = 2 \
             AND classid = (hashtext('{HISTORY_TABLE}')::bigint & 4294967295)::oid AND objid = (hashtext(current_schema())::bigint & 4294967295)::oid)"
        ),
    }
}

/// The maximum time a statement waits for another session's lock (lock wait in docs/spec/plans.md "Apply").
const LOCK_WAIT_SECONDS: i64 = 5;

const APPLYING: &str = "applying";
const APPLIED: &str = "applied";
const FINALIZING: &str = "finalizing";
const DONE: &str = "done";
const ROLLING_BACK: &str = "rolling_back";

/// The handler of the command events.
pub type ApplyEvents<'e> = dyn FnMut(&ApplyEvent) -> Result<(), ApplyEventError> + Send + 'e;

/// The clock of the `applied_at` column.
pub type ApplyClock<'c> = dyn Fn() -> DateTime<Utc> + Sync + 'c;

/// The query of each effect kind in `dialect`, or `None`. Its arguments are
/// those of the effect's table and name that it reads, and it counts.
pub fn effect_query(dialect: Dialect, kind: &str) -> Option<&'static str> {
    Some(match (dialect, kind) {
        (Dialect::MySql, "table") => "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
        (Dialect::MySql, "column") => "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
        (Dialect::MySql, "index") => "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
        (Dialect::MySql, "constraint") => {
            "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?"
        }
        (Dialect::MySql, "trigger") => {
            "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ? AND TRIGGER_NAME = ?"
        }
        (Dialect::Postgres, "table") => {
            "SELECT COUNT(*) FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p') AND relname = $1"
        }
        (Dialect::Postgres, "column") => {
            "SELECT COUNT(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = $1 AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped"
        }
        (Dialect::Postgres, "index") => {
            "SELECT COUNT(*) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = $1 AND i.relname = $2"
        }
        (Dialect::Postgres, "constraint") => {
            "SELECT COUNT(*) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = $1 AND k.conname = $2"
        }
        (Dialect::Postgres, "trigger") => {
            "SELECT COUNT(*) FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = $1 AND g.tgname = $2 AND NOT g.tgisinternal"
        }
        (Dialect::Postgres, "function") => "SELECT COUNT(*) FROM pg_proc WHERE pronamespace = current_schema()::regnamespace AND proname = $1",
        (Dialect::Sqlite, "table") => "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
        (Dialect::Sqlite, "column") => "SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?",
        (Dialect::Sqlite, "index") => "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ?",
        (Dialect::Sqlite, "trigger") => "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND name = ?",
        (Dialect::Sqlite, "sequence") => "SELECT COUNT(*) FROM sqlite_sequence WHERE name = ?",
        _ => return None,
    })
}

/// Reads whether `effect` holds on the connection now.
pub async fn effect_holds<C: ApplyConnection + ?Sized>(connection: &mut C, dialect: Dialect, effect: &Effect) -> Result<bool, sqlx::Error> {
    let (query, args) = if effect.kind == "rows" {
        (format!("SELECT COUNT(*) FROM (SELECT 1 FROM {} LIMIT 1) x", quote(dialect, &effect.table)), Vec::new())
    } else {
        let query = effect_query(dialect, effect.kind).ok_or_else(|| protocol(format!("the effect {effect} has no query on {dialect:?}")))?;
        let args = match effect.kind {
            "table" | "sequence" => vec![CatalogValue::Text(effect.table.clone())],
            "function" => vec![CatalogValue::Text(effect.name.clone())],
            _ => vec![CatalogValue::Text(effect.table.clone()), CatalogValue::Text(effect.name.clone())],
        };
        (query.to_owned(), args)
    };
    let rows = connection.query_bound(&query, &args).await?;
    let n = match rows.as_slice() {
        [row] => match row.as_slice() {
            [CatalogValue::Int(n)] => *n,
            other => return Err(protocol(format!("{query} returned {other:?}"))),
        },
        _ => return Err(protocol(format!("{query} returned {} rows; want one", rows.len()))),
    };
    Ok((n > 0) == effect.present)
}

macro_rules! apply_entrypoint {
    ($(#[$doc:meta])* $name:ident, $command:ident) => {
        $(#[$doc])*
        pub async fn $name<C: ApplyConnection + ?Sized>(
            connection: &mut C,
            dialect: Dialect,
            plans: &[Plan],
            now: &ApplyClock<'_>,
            events: &mut ApplyEvents<'_>,
        ) -> Result<(), ApplyError> {
            run_command(connection, dialect, plans, now, events, Command::$command).await
        }
    };
}

apply_entrypoint!(
    /// Applies, step by step, the plans of the chain of `plans` that the database
    /// of `connection` has not applied, up to their finalize steps; on a database
    /// that has applied the whole chain it changes nothing. `dialect` must be the
    /// database of the connection, `now` gives `applied_at` and `events` receives
    /// every event; an error it returns stops the command at that point. When
    /// restoring the session settings or SQLite foreign keys, or releasing the
    /// lock, fails after a failure, the result is [`ApplyError::Cleanup`] with
    /// both.
    apply,
    Apply
);
apply_entrypoint!(
    /// Continues the interrupted plan forward from the catalog effect of the step
    /// after its recorded one, up to `applied`, or to `done` for a finalizing
    /// plan. Without an interrupted plan it changes nothing. Failures are
    /// reported as for [`apply`].
    recover,
    Recover
);
apply_entrypoint!(
    /// Undoes the last plan of the history with its rollback statements down to
    /// its first step and deletes its row. An applied plan is checked for drift
    /// and NULL rows first; a step without rollback stops it with
    /// [`ApplyError::Irreversible`]. Without a row it changes nothing. Failures
    /// are reported as for [`apply`].
    rollback,
    Rollback
);
apply_entrypoint!(
    /// Runs the finalize steps of every applied plan in chain order, dropping the
    /// hidden tables and columns, and records the plans `done`. Failures are
    /// reported as for [`apply`].
    finalize,
    Finalize
);

#[derive(Clone, Copy)]
enum Command {
    Apply,
    Recover,
    Rollback,
    Finalize,
}

async fn run_command<C: ApplyConnection + ?Sized>(
    connection: &mut C,
    dialect: Dialect,
    plans: &[Plan],
    now: &ApplyClock<'_>,
    events: &mut ApplyEvents<'_>,
    command: Command,
) -> Result<(), ApplyError> {
    let mut applier = Applier::new(connection, dialect, plans, now, events)?;
    let restore = applier.open().await?;
    let result = match command {
        Command::Apply => applier.apply_chain().await,
        Command::Recover => applier.recover_chain().await,
        Command::Rollback => applier.rollback_chain().await,
        Command::Finalize => applier.finalize_chain().await,
    };
    applier.close(result, restore).await
}

/// One row of the history table.
struct HistoryRow {
    name: String,
    from: String,
    to: String,
    state: String,
    step: usize,
}

/// Session settings the command reverts at the end.
enum Restore {
    MySql { lock_wait: i64, row_wait: i64 },
    Postgres { lock_timeout: String },
    Sqlite { foreign_keys: i64, legacy: i64, mode: String, busy: i64 },
}

/// The state of one command run.
struct Applier<'a, C: ?Sized> {
    c: &'a mut C,
    d: Dialect,
    now: &'a ApplyClock<'a>,
    events: &'a mut ApplyEvents<'a>,
    chain: Vec<&'a Plan>,
    history: Vec<HistoryRow>,
    /// The id of the server session holding the lock (MySQL CONNECTION_ID, PostgreSQL pg_backend_pid).
    server_session: i64,
}

/// The dialect's identifier quote.
fn quote(d: Dialect, name: &str) -> String {
    match d {
        Dialect::MySql => format!("`{name}`"),
        _ => format!("\"{name}\""),
    }
}

fn hash_or_empty(hash: Option<&str>) -> &str {
    hash.unwrap_or("empty")
}

/// The index of the first finalize step.
fn finalize_start(steps: &[PlanStep]) -> usize {
    steps.iter().position(|s| s.finalize).unwrap_or(steps.len())
}

impl<'a, C: ApplyConnection + ?Sized> Applier<'a, C> {
    fn new(c: &'a mut C, d: Dialect, plans: &'a [Plan], now: &'a ApplyClock<'a>, events: &'a mut ApplyEvents<'a>) -> Result<Self, ApplyError> {
        let chain = chain(plans).map_err(|diagnostics| ApplyError::Chain { plan: None, message: diagnostics[0].message.clone() })?;
        Ok(Applier { c, d, now, events, chain, history: Vec::new(), server_session: 0 })
    }

    fn q(&self, name: &str) -> String {
        quote(self.d, name)
    }

    fn history_columns(&self) -> [String; 7] {
        HISTORY_COLUMNS.map(|name| self.q(name))
    }

    fn placeholder(&self, n: usize) -> String {
        match self.d {
            Dialect::Postgres => format!("${n}"),
            _ => "?".to_owned(),
        }
    }

    /// The values of a query that returns one row.
    async fn row(&mut self, query: &str, args: &[CatalogValue]) -> Result<Vec<CatalogValue>, ApplyError> {
        let rows = self.c.query_bound(query, args).await?;
        match <[Vec<CatalogValue>; 1]>::try_from(rows) {
            Ok([row]) => Ok(row),
            Err(rows) => Err(ApplyError::Database(protocol(format!("{query} returned {} rows; want one", rows.len())))),
        }
    }

    /// The value of a query that returns only one value.
    async fn value(&mut self, query: &str) -> Result<CatalogValue, ApplyError> {
        let row = self.row(query, &[]).await?;
        match <[CatalogValue; 1]>::try_from(row) {
            Ok([value]) => Ok(value),
            Err(row) => Err(ApplyError::Database(protocol(format!("{query} returned {} values; want one", row.len())))),
        }
    }

    async fn integer(&mut self, query: &str) -> Result<i64, ApplyError> {
        match self.value(query).await? {
            CatalogValue::Int(n) => Ok(n),
            other => Err(ApplyError::Database(protocol(format!("{query} returned {other:?}; want an integer")))),
        }
    }

    async fn text(&mut self, query: &str) -> Result<String, ApplyError> {
        match self.value(query).await? {
            CatalogValue::Text(t) => Ok(t),
            other => Err(ApplyError::Database(protocol(format!("{query} returned {other:?}; want text")))),
        }
    }

    async fn exec(&mut self, statement: &str) -> Result<(), ApplyError> {
        Ok(self.c.execute(statement).await?)
    }

    /// Remembers the server session's id before taking the lock. If that session already holds the lock, another
    /// client is using the same server session, so it is a session error.
    async fn open_session(&mut self) -> Result<(), ApplyError> {
        let query = session_query(self.d);
        let row = self.row(&query, &[]).await?;
        let held = match row.as_slice() {
            [CatalogValue::Int(id), CatalogValue::Bool(held)] => {
                self.server_session = *id;
                *held
            }
            [CatalogValue::Int(id), CatalogValue::Int(held)] => {
                self.server_session = *id;
                *held != 0
            }
            _ => return Err(ApplyError::Database(protocol(format!("{query} returned {row:?}")))),
        };
        if held {
            return Err(ApplyError::Session {
                plan: None,
                message: format!("this server session already holds the {HISTORY_TABLE} lock, so another client shares it; {SESSION_REQUIREMENT}"),
            });
        }
        Ok(())
    }

    /// Checks that current is the server session holding the lock. A mismatch is a session error before the step of `plan`
    /// (or at the lock when None).
    fn same_session(&self, plan: Option<(&Plan, usize)>, current: i64) -> Result<(), ApplyError> {
        if current == self.server_session {
            return Ok(());
        }
        Err(ApplyError::Session {
            plan: plan.map(|(p, i)| (p.name().to_owned(), i)),
            message: format!("the connection moved from server session {} to {current}; {SESSION_REQUIREMENT}", self.server_session),
        })
    }

    /// Splits the result row of the lock query (lock result, server session id).
    fn lock_row(query: &str, row: Vec<CatalogValue>) -> Result<(CatalogValue, i64), ApplyError> {
        match <[CatalogValue; 2]>::try_from(row) {
            Ok([got, CatalogValue::Int(current)]) => Ok((got, current)),
            Ok(row) => Err(ApplyError::Database(protocol(format!("{query} returned {row:?}")))),
            Err(row) => Err(ApplyError::Database(protocol(format!("{query} returned {} values; want two", row.len())))),
        }
    }

    /// Takes the dialect's lock and changes session settings. On failure, the changes so far
    /// are reverted and released, then the error is returned.
    async fn open(&mut self) -> Result<Restore, ApplyError> {
        match self.d {
            Dialect::MySql => {
                self.open_session().await?;
                // A NULL from GET_LOCK is an error while waiting for the lock.
                let query = format!("SELECT GET_LOCK({MYSQL_LOCK}, 0), CONNECTION_ID()");
                let (got, current) = Self::lock_row(&query, self.row(&query, &[]).await?)?;
                match got {
                    CatalogValue::Int(1) => {}
                    CatalogValue::Int(0) => {
                        return Err(ApplyError::Locked { message: format!("another session holds the {HISTORY_TABLE} lock of this database"), source: None });
                    }
                    other => return Err(ApplyError::Database(protocol(format!("GET_LOCK returned {other:?}; want 1 or 0")))),
                }
                let settings = async {
                    self.same_session(None, current)?;
                    let query = "SELECT @@SESSION.lock_wait_timeout, @@SESSION.innodb_lock_wait_timeout";
                    let row = self.row(query, &[]).await?;
                    let [CatalogValue::Int(lock_wait), CatalogValue::Int(row_wait)] = row.as_slice() else {
                        return Err(ApplyError::Database(protocol(format!("{query} returned {row:?}"))));
                    };
                    let (lock_wait, row_wait) = (*lock_wait, *row_wait);
                    self.exec(&format!("SET SESSION lock_wait_timeout = {LOCK_WAIT_SECONDS}, innodb_lock_wait_timeout = {LOCK_WAIT_SECONDS}")).await?;
                    Ok(Restore::MySql { lock_wait, row_wait })
                }
                .await;
                match settings {
                    Ok(restore) => Ok(restore),
                    Err(error) => Err(self.release_after_setup_error(error).await),
                }
            }
            Dialect::Postgres => {
                self.open_session().await?;
                // If current_schema() is NULL, the result is also NULL and is an error.
                let query = format!("SELECT pg_try_advisory_lock({POSTGRES_LOCK}), pg_backend_pid()");
                let (got, current) = Self::lock_row(&query, self.row(&query, &[]).await?)?;
                match got {
                    CatalogValue::Bool(true) => {}
                    CatalogValue::Bool(false) => {
                        return Err(ApplyError::Locked {
                            message: format!("another session holds the {HISTORY_TABLE} advisory lock of this schema"),
                            source: None,
                        });
                    }
                    other => return Err(ApplyError::Database(protocol(format!("pg_try_advisory_lock returned {other:?}")))),
                }
                let settings = async {
                    self.same_session(None, current)?;
                    let lock_timeout = self.text("SELECT current_setting('lock_timeout')").await?;
                    self.value(&format!("SELECT set_config('lock_timeout', '{LOCK_WAIT_SECONDS}s', false)")).await?;
                    Ok(Restore::Postgres { lock_timeout })
                }
                .await;
                match settings {
                    Ok(restore) => Ok(restore),
                    Err(error) => Err(self.release_after_setup_error(error).await),
                }
            }
            Dialect::Sqlite => {
                let foreign_keys = self.integer("PRAGMA foreign_keys").await?;
                let legacy = self.integer("PRAGMA legacy_alter_table").await?;
                let busy = self.integer("PRAGMA busy_timeout").await?;
                let mode = self.text("PRAGMA locking_mode").await?;
                self.exec(&format!("PRAGMA busy_timeout = {}", LOCK_WAIT_SECONDS * 1000)).await?;
                let restore = Restore::Sqlite { foreign_keys, legacy, mode, busy };
                let locked = async {
                    self.exec("PRAGMA locking_mode = EXCLUSIVE").await?;
                    if let Err(e) = self.c.execute("BEGIN EXCLUSIVE").await {
                        if sqlite_lock_result(&e) {
                            return Err(ApplyError::Locked { message: "another connection holds the SQLite database".to_owned(), source: Some(e) });
                        }
                        return Err(ApplyError::Database(e));
                    }
                    self.exec("COMMIT").await?;
                    self.exec("PRAGMA foreign_keys = OFF").await?;
                    self.exec("PRAGMA legacy_alter_table = OFF").await
                }
                .await;
                match locked {
                    Ok(()) => Ok(restore),
                    Err(e) => Err(self.close(Err(e), restore).await.expect_err("a failure stays a failure")),
                }
            }
        }
    }

    async fn release_after_setup_error(&mut self, error: ApplyError) -> ApplyError {
        settle(Err(error), self.release().await).expect_err("a failure stays a failure")
    }

    /// Releases the MySQL and PostgreSQL lock. On PostgreSQL, an unlock that releases nothing is an error.
    async fn release(&mut self) -> Result<(), ApplyError> {
        match self.d {
            Dialect::MySql => self.exec(&format!("DO RELEASE_LOCK({MYSQL_LOCK})")).await,
            Dialect::Postgres => match self.value(&format!("SELECT pg_advisory_unlock({POSTGRES_LOCK})")).await? {
                CatalogValue::Bool(true) => Ok(()),
                CatalogValue::Bool(false) => Err(ApplyError::LockNotHeld { message: format!("the advisory lock of {HISTORY_TABLE} was not held at unlock") }),
                other => Err(ApplyError::Database(protocol(format!("pg_advisory_unlock returned {other:?}")))),
            },
            Dialect::Sqlite => Ok(()),
        }
    }

    /// Reverts session settings and releases the lock. A cleanup failure is reported together with the earlier error.
    async fn close(&mut self, result: Result<(), ApplyError>, restore: Restore) -> Result<(), ApplyError> {
        match restore {
            Restore::MySql { lock_wait, row_wait } => {
                let restored = self.exec(&format!("SET SESSION lock_wait_timeout = {lock_wait}, innodb_lock_wait_timeout = {row_wait}")).await;
                let result = settle(result, restored);
                let released = self.release().await;
                settle(result, released)
            }
            Restore::Postgres { lock_timeout } => {
                let restored = self
                    .c
                    .query_bound("SELECT set_config('lock_timeout', $1, false)", &[CatalogValue::Text(lock_timeout)])
                    .await
                    .map(drop)
                    .map_err(ApplyError::from);
                let result = settle(result, restored);
                let released = self.release().await;
                settle(result, released)
            }
            Restore::Sqlite { foreign_keys, legacy, mode, busy } => {
                let mut result = result;
                for statement in
                    [format!("PRAGMA foreign_keys = {foreign_keys}"), format!("PRAGMA legacy_alter_table = {legacy}"), format!("PRAGMA locking_mode = {mode}")]
                {
                    let done = self.exec(&statement).await;
                    result = settle(result, done);
                }
                // After reverting the locking mode, one read is needed for the exclusive lock to be released.
                let read = self.value("SELECT COUNT(*) FROM sqlite_master").await.map(drop);
                result = settle(result, read);
                let done = self.exec(&format!("PRAGMA busy_timeout = {busy}")).await;
                settle(result, done)
            }
        }
    }

    async fn apply_chain(&mut self) -> Result<(), ApplyError> {
        let position = self.settled().await?;
        for i in position..self.chain.len() {
            let p = self.chain[i];
            self.apply_plan(p).await?;
        }
        Ok(())
    }

    async fn recover_chain(&mut self) -> Result<(), ApplyError> {
        let Some((p, state, step)) = self.last_history_plan().await? else { return Ok(()) };
        if state == APPLIED || state == DONE {
            return Ok(());
        }
        let steps = self.steps(p)?;
        let k = self.resolve(p, &state, step, &steps, true).await?;
        if state == FINALIZING {
            self.emit(ApplyEventKind::Finalize, p, 0, steps.len(), "")?;
            return self.finalize_from(p, &steps, k).await;
        }
        self.emit(ApplyEventKind::Plan, p, 0, steps.len(), "")?;
        self.record(p, APPLYING, k, steps.len()).await?;
        self.forward(p, &steps, k).await
    }

    async fn rollback_chain(&mut self) -> Result<(), ApplyError> {
        let Some((p, state, step)) = self.last_history_plan().await? else { return Ok(()) };
        let steps = self.steps(p)?;
        let applied = state == APPLIED || state == DONE;
        let k = if applied {
            if step > steps.len() {
                return Err(ApplyError::Chain {
                    plan: Some(p.name().to_owned()),
                    message: format!("the recorded step {step} is outside the plan's {} steps", steps.len()),
                });
            }
            self.verify(Some(p.to())).await.map_err(|error| drift_or_verification_error(Some(p.name().to_owned()), error))?;
            step
        } else {
            self.resolve(p, &state, step, &steps, false).await?
        };
        if k > 0 && steps[k - 1].rollback.is_empty() {
            return Err(irreversible(p, &steps, k - 1));
        }
        if applied {
            self.null_checks(p, &steps[..k]).await?;
        }
        self.emit(ApplyEventKind::Rollback, p, 0, steps.len(), "")?;
        self.record(p, ROLLING_BACK, k, steps.len()).await?;
        for i in (0..k).rev() {
            let s = &steps[i];
            if s.rollback.is_empty() {
                return Err(irreversible(p, &steps, i));
            }
            let mut statement = s.rollback.clone();
            if !s.rollback_restore.is_empty() && self.effect(p, i, s.restore_if.as_ref()).await? {
                statement = s.rollback_restore.clone();
            }
            self.run(p, steps.len(), i, &statement).await?;
            self.set_step(p, i).await?;
        }
        self.foreign_key_check(p).await?;
        self.verify(p.from()).await.map_err(|error| verification_error(p.name().to_owned(), error))?;
        self.emit(ApplyEventKind::Verified, p, 0, steps.len(), "")?;
        let delete = format!("DELETE FROM {} WHERE {} = {}", self.q(HISTORY_TABLE), self.q("name"), self.placeholder(1));
        self.c.execute_bound(&delete, &[CatalogValue::Text(p.name().to_owned())]).await?;
        self.emit(ApplyEventKind::Done, p, 0, steps.len(), "")
    }

    async fn finalize_chain(&mut self) -> Result<(), ApplyError> {
        let position = self.settled().await?;
        for i in 0..position {
            let p = self.chain[i];
            if self.row_of(p).0 != APPLIED {
                continue;
            }
            let steps = self.steps(p)?;
            self.emit(ApplyEventKind::Finalize, p, 0, steps.len(), "")?;
            let start = finalize_start(&steps);
            self.record(p, FINALIZING, start, steps.len()).await?;
            self.finalize_from(p, &steps, start).await?;
        }
        Ok(())
    }

    async fn last_history_plan(&mut self) -> Result<Option<(&'a Plan, String, usize)>, ApplyError> {
        let position = self.position().await?;
        let Some(plan) = position.checked_sub(1).and_then(|index| self.chain.get(index).copied()) else { return Ok(None) };
        let (state, step) = self.row_of(plan);
        Ok(Some((plan, state, step)))
    }

    fn row_of(&self, p: &Plan) -> (String, usize) {
        self.history.iter().find(|r| r.name == p.name()).map(|r| (r.state.clone(), r.step)).expect("a recorded plan has a history row")
    }

    /// Creates the history table if it does not exist.
    async fn create_history(&mut self) -> Result<(), ApplyError> {
        let (integer, text, tail) = match self.d {
            Dialect::MySql => ("INT", "varchar(71) CHARACTER SET ascii COLLATE ascii_bin", " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin"),
            _ => ("integer", "varchar(71)", ""),
        };
        let columns = self.history_columns();
        let statement = format!(
            "CREATE TABLE IF NOT EXISTS {} ({} {text} NOT NULL, {} {text} NOT NULL, {} {text} NOT NULL, {} {text} NOT NULL, {} {integer} NOT NULL, {} {integer} NOT NULL, {} {text} NOT NULL, PRIMARY KEY ({})){tail}",
            self.q(HISTORY_TABLE),
            columns[0],
            columns[1],
            columns[2],
            columns[3],
            columns[4],
            columns[5],
            columns[6],
            columns[0],
        );
        self.exec(&statement).await
    }

    async fn read_history(&mut self) -> Result<(), ApplyError> {
        self.create_history().await?;
        let columns = self.history_columns();
        let query = format!("SELECT {}, {}, {}, {}, {} FROM {}", columns[0], columns[1], columns[2], columns[3], columns[4], self.q(HISTORY_TABLE));
        let rows = self.c.query_bound(&query, &[]).await?;
        self.history = rows
            .into_iter()
            .map(|row| match <[CatalogValue; 5]>::try_from(row) {
                Ok([CatalogValue::Text(name), CatalogValue::Text(from), CatalogValue::Text(to), CatalogValue::Text(state), CatalogValue::Int(step)]) => {
                    let step = usize::try_from(step)
                        .map_err(|error| ApplyError::Database(protocol(format!("{HISTORY_TABLE} row {name} has the step {step}: {error}"))))?;
                    Ok(HistoryRow { name, from, to, state, step })
                }
                Ok(other) => Err(ApplyError::Database(protocol(format!("{HISTORY_TABLE} has the row {other:?}")))),
                Err(other) => Err(ApplyError::Database(protocol(format!("{HISTORY_TABLE} has the row {other:?}")))),
            })
            .collect::<Result<_, _>>()?;
        Ok(())
    }

    /// Reads history and returns the number of recorded plans. The records must be a prefix of the chain,
    /// and every row before the last must be applied or done.
    async fn position(&mut self) -> Result<usize, ApplyError> {
        self.read_history().await?;
        let mut position = 0;
        for (i, p) in self.chain.iter().enumerate() {
            let Some(row) = self.history.iter().find(|r| r.name == p.name()) else {
                continue;
            };
            if row.to != p.to() || row.from != hash_or_empty(p.from()) {
                return Err(ApplyError::Chain {
                    plan: Some(p.name().to_owned()),
                    message: "the recorded plan has other hashes than the chain's plan".to_owned(),
                });
            }
            if i != position {
                return Err(ApplyError::Chain { plan: Some(p.name().to_owned()), message: "a plan before it in the chain is not recorded".to_owned() });
            }
            if ![APPLYING, APPLIED, FINALIZING, DONE, ROLLING_BACK].contains(&row.state.as_str()) {
                return Err(ApplyError::Chain { plan: Some(p.name().to_owned()), message: format!("the recorded state {} is not a history state", row.state) });
            }
            position = i + 1;
        }
        if self.history.len() != position {
            return Err(ApplyError::Chain { plan: None, message: "the history records a plan that is not in the chain".to_owned() });
        }
        for p in &self.chain[..position.saturating_sub(1)] {
            let (state, _) = self.row_of(p);
            if state != APPLIED && state != DONE {
                return Err(ApplyError::Chain { plan: Some(p.name().to_owned()), message: format!("a plan before the last is {state}") });
            }
        }
        Ok(position)
    }

    /// Returns the number of recorded plans when there is no interrupted plan and the catalog matches the recorded schema.
    async fn settled(&mut self) -> Result<usize, ApplyError> {
        let position = self.position().await?;
        let mut want = None;
        if position > 0 {
            let p = self.chain[position - 1];
            let (state, step) = self.row_of(p);
            if state != APPLIED && state != DONE {
                return Err(ApplyError::Interrupted { plan: p.name().to_owned(), step, message: format!("the plan is {state}; run recover or rollback") });
            }
            want = Some(p.to());
        }
        self.verify(want).await.map_err(|error| drift_or_verification_error(None, error))?;
        Ok(position)
    }

    /// The database's introspection has the `want` schemaHash (None means an empty database), and
    /// there are no unsupported objects. If it differs, returns that difference.
    async fn verify(&mut self, want: Option<&str>) -> Result<(), VerifyError> {
        let introspection = introspect(&mut *self.c, self.d, "schema").await.map_err(VerifyError::Introspection)?;
        if let Some(u) = introspection.unsupported.first() {
            return Err(VerifyError::Mismatch(format!(
                "the database has {} objects that dbspec cannot express, first {} {} {}: {}",
                introspection.unsupported.len(),
                u.kind,
                u.table,
                u.name,
                u.reason
            )));
        }
        let got = if introspection.document.tables.is_empty() {
            None
        } else {
            let m = manifest(&[&introspection.document])
                .map_err(|diagnostics| VerifyError::Mismatch(format!("the introspected schema is invalid: {diagnostics:?}")))?;
            Some(m.schema_hash)
        };
        if got.as_deref() != want {
            return Err(VerifyError::Mismatch(format!("the database is at {}, not {}", hash_or_empty(got.as_deref()), hash_or_empty(want))));
        }
        Ok(())
    }

    /// Writes the steps in the chain, using the target of the plan before this plan as the source.
    fn steps(&self, p: &Plan) -> Result<Vec<PlanStep>, ApplyError> {
        let index = self.chain.iter().position(|c| std::ptr::eq(*c, p));
        let source = index.filter(|&i| i > 0).map(|i| self.chain[i - 1].schema());
        plan_steps(source, p, self.d).map_err(|diagnostics| ApplyError::Chain { plan: Some(p.name().to_owned()), message: diagnostics[0].message.clone() })
    }

    /// Decides the step of the interrupted row from the catalog's effect. Moves forward if forward, otherwise backward
    /// to the position to continue from (recover in docs/spec/plans.md "Apply").
    async fn resolve(&mut self, p: &Plan, state: &str, k: usize, steps: &[PlanStep], forward: bool) -> Result<usize, ApplyError> {
        if k > steps.len() {
            return Err(ApplyError::Chain {
                plan: Some(p.name().to_owned()),
                message: format!("the recorded step {k} is outside the plan's {} steps", steps.len()),
            });
        }
        let rolling = state == ROLLING_BACK;
        let uncertain = if rolling { k.checked_sub(1) } else { Some(k) };
        let Some(uncertain) = uncertain.filter(|&u| u < steps.len()) else {
            return Ok(k);
        };
        let e = &steps[uncertain].effect;
        let held = e.kind != "repeat" && self.effect(p, uncertain, Some(e)).await?;
        // When moving forward, repeat steps run again; when moving backward, their rollback runs again.
        let took = held || (!forward && e.kind == "repeat");
        Ok(match (rolling, took) {
            (true, true) => k,
            (true, false) => k - 1,
            (false, true) => k + 1,
            (false, false) => k,
        })
    }

    /// Writes the plan's row as state and step. Creates the row if it does not exist.
    async fn record(&mut self, p: &Plan, state: &str, step: usize, steps: usize) -> Result<(), ApplyError> {
        let count = |n: usize| i64::try_from(n).map_err(|error| ApplyError::Database(protocol(format!("the step {n} does not fit a history row: {error}"))));
        if !self.history.iter().any(|r| r.name == p.name()) {
            let placeholders: Vec<String> = (1..=7).map(|n| self.placeholder(n)).collect();
            let columns = self.history_columns();
            let insert = format!("INSERT INTO {} ({}) VALUES ({})", self.q(HISTORY_TABLE), columns.join(", "), placeholders.join(", "));
            // applied_at is the tool clock's UTC time truncated to six fractional digits, as text (docs/spec/plans.md "Apply").
            let applied_at = (self.now)().format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string();
            let args = [
                CatalogValue::Text(p.name().to_owned()),
                CatalogValue::Text(hash_or_empty(p.from()).to_owned()),
                CatalogValue::Text(p.to().to_owned()),
                CatalogValue::Text(state.to_owned()),
                CatalogValue::Int(count(step)?),
                CatalogValue::Int(count(steps)?),
                CatalogValue::Text(applied_at),
            ];
            self.c.execute_bound(&insert, &args).await?;
            self.history.push(HistoryRow {
                name: p.name().to_owned(),
                from: hash_or_empty(p.from()).to_owned(),
                to: p.to().to_owned(),
                state: state.to_owned(),
                step,
            });
            return Ok(());
        }
        let update = format!(
            "UPDATE {} SET {} = {}, {} = {} WHERE {} = {}",
            self.q(HISTORY_TABLE),
            self.q("state"),
            self.placeholder(1),
            self.q("step"),
            self.placeholder(2),
            self.q("name"),
            self.placeholder(3)
        );
        let args = [CatalogValue::Text(state.to_owned()), CatalogValue::Int(count(step)?), CatalogValue::Text(p.name().to_owned())];
        Ok(self.c.execute_bound(&update, &args).await?)
    }

    async fn set_step(&mut self, p: &Plan, step: usize) -> Result<(), ApplyError> {
        let step = i64::try_from(step).map_err(|error| ApplyError::Database(protocol(format!("the step {step} does not fit a history row: {error}"))))?;
        let update =
            format!("UPDATE {} SET {} = {} WHERE {} = {}", self.q(HISTORY_TABLE), self.q("step"), self.placeholder(1), self.q("name"), self.placeholder(2));
        Ok(self.c.execute_bound(&update, &[CatalogValue::Int(step), CatalogValue::Text(p.name().to_owned())]).await?)
    }

    /// Applies one plan up to the finalize step and verifies it.
    async fn apply_plan(&mut self, p: &Plan) -> Result<(), ApplyError> {
        let steps = self.steps(p)?;
        self.emit(ApplyEventKind::Plan, p, 0, steps.len(), "")?;
        for (i, s) in steps[..finalize_start(&steps)].iter().enumerate() {
            if s.rollback.is_empty() {
                self.emit(ApplyEventKind::Irreversible, p, i, steps.len(), &s.statement)?;
            }
        }
        self.record(p, APPLYING, 0, steps.len()).await?;
        self.forward(p, &steps, 0).await
    }

    /// Runs from step start up to the finalize step, verifies, then changes the row to applied.
    async fn forward(&mut self, p: &Plan, steps: &[PlanStep], start: usize) -> Result<(), ApplyError> {
        let end = finalize_start(steps);
        for (i, s) in steps.iter().enumerate().take(end).skip(start) {
            let mut statement = s.statement.clone();
            if !s.restore.is_empty() && self.effect(p, i, s.restore_if.as_ref()).await? {
                statement = s.restore.clone();
            }
            self.run(p, steps.len(), i, &statement).await?;
            self.set_step(p, i + 1).await?;
        }
        self.foreign_key_check(p).await?;
        self.verify(Some(p.to())).await.map_err(|error| verification_error(p.name().to_owned(), error))?;
        self.emit(ApplyEventKind::Verified, p, 0, steps.len(), "")?;
        self.record(p, APPLIED, end, steps.len()).await?;
        self.emit(ApplyEventKind::Done, p, 0, steps.len(), "")
    }

    /// Runs the finalize step from start and changes the row to done.
    async fn finalize_from(&mut self, p: &Plan, steps: &[PlanStep], start: usize) -> Result<(), ApplyError> {
        for (i, s) in steps.iter().enumerate().skip(start) {
            self.run(p, steps.len(), i, &s.statement).await?;
            self.set_step(p, i + 1).await?;
        }
        self.record(p, DONE, steps.len(), steps.len()).await?;
        self.emit(ApplyEventKind::Done, p, 0, steps.len(), "")
    }

    /// Runs one statement of step i together with its event. Before the statement, the server session
    /// is checked (a SQLite connection is one file's connection).
    async fn run(&mut self, p: &Plan, steps: usize, i: usize, statement: &str) -> Result<(), ApplyError> {
        self.emit(ApplyEventKind::Statement, p, i, steps, statement)?;
        let query = match self.d {
            Dialect::MySql => Some("SELECT CONNECTION_ID()"),
            Dialect::Postgres => Some("SELECT pg_backend_pid()"),
            Dialect::Sqlite => None,
        };
        if let Some(query) = query {
            let current = match self.c.query_bound(query, &[]).await {
                Ok(rows) => match rows.as_slice() {
                    [row] => match row.as_slice() {
                        [CatalogValue::Int(id)] => *id,
                        _ => return Err(ApplyError::Database(protocol(format!("{query} returned {row:?}")))),
                    },
                    _ => return Err(ApplyError::Database(protocol(format!("{query} returned {} rows; want one", rows.len())))),
                },
                Err(source) => return Err(ApplyError::Failed { plan: p.name().to_owned(), step: i, statement: query.to_owned(), source }),
            };
            self.same_session(Some((p, i)), current)?;
        }
        if let Err(source) = self.c.execute(statement).await {
            return Err(ApplyError::Failed { plan: p.name().to_owned(), step: i, statement: statement.to_owned(), source });
        }
        self.emit(ApplyEventKind::Applied, p, i, steps, statement)
    }

    /// Checks on SQLite that no row violates a foreign key.
    async fn foreign_key_check(&mut self, p: &Plan) -> Result<(), ApplyError> {
        if self.d != Dialect::Sqlite {
            return Ok(());
        }
        match self.integer("SELECT COUNT(*) FROM pragma_foreign_key_check").await? {
            0 => Ok(()),
            broken => Err(ApplyError::Verify { plan: p.name().to_owned(), message: format!("{broken} rows break a foreign key"), source: None }),
        }
    }

    /// For the NULL rows of a column that the applied plan's rollback would revert to non-null,
    /// fills them with the default, or stops with a nulls error if there is no default (docs/spec/plans.md "Steps").
    async fn null_checks(&mut self, p: &Plan, steps: &[PlanStep]) -> Result<(), ApplyError> {
        for (i, s) in steps.iter().enumerate() {
            for c in &s.null_checks {
                let n = self.integer(&format!("SELECT COUNT(*) FROM {} WHERE {} IS NULL", self.q(&c.table), self.q(&c.column))).await?;
                if n == 0 {
                    continue;
                }
                let Some(default) = &c.default else {
                    return Err(ApplyError::Nulls {
                        plan: p.name().to_owned(),
                        step: i,
                        message: format!("column {}.{} has {n} NULL rows and no default to restore NOT NULL", c.table, c.column),
                    });
                };
                let fill = format!("UPDATE {} SET {} = {default} WHERE {} IS NULL", self.q(&c.table), self.q(&c.column), self.q(&c.column));
                self.exec(&fill).await?;
            }
        }
        Ok(())
    }

    /// Reports whether the effect is now in the database. If it cannot be read, it is the step's failed error.
    async fn effect(&mut self, p: &Plan, step: usize, e: Option<&Effect>) -> Result<bool, ApplyError> {
        let e = e.expect("a step with a restore statement has its effect");
        effect_holds(&mut *self.c, self.d, e).await.map_err(|source| ApplyError::Failed { plan: p.name().to_owned(), step, statement: String::new(), source })
    }

    fn emit(&mut self, kind: ApplyEventKind, p: &Plan, step: usize, steps: usize, statement: &str) -> Result<(), ApplyError> {
        (self.events)(&ApplyEvent { kind, plan: p.name().to_owned(), step, steps, statement: statement.to_owned() }).map_err(ApplyError::Event)
    }
}

fn sqlite_lock_result(error: &sqlx::Error) -> bool {
    let Some(code) = error.as_database_error().and_then(|database| database.code()) else {
        return false;
    };
    match code.parse::<i32>() {
        Ok(code) => matches!(code & 0xff, 5 | 6),
        Err(_) => false,
    }
}
fn irreversible(p: &Plan, steps: &[PlanStep], i: usize) -> ApplyError {
    let message = if steps[i].finalize { "a finalize step has no rollback".to_owned() } else { steps[i].irreversible.clone() };
    ApplyError::Irreversible { plan: p.name().to_owned(), step: i, message }
}

/// Adds the cleanup statement's result to `result`. If there is an earlier error, the cleanup failure
/// is returned together with that error.
fn settle(result: Result<(), ApplyError>, cleanup: Result<(), ApplyError>) -> Result<(), ApplyError> {
    match (result, cleanup) {
        (result, Ok(())) => result,
        (Ok(()), Err(e)) => Err(e),
        (Err(error), Err(cleanup)) => Err(ApplyError::Cleanup { error: Box::new(error), cleanup: Box::new(cleanup) }),
    }
}

/// The error for a result that does not have the expected shape.
fn protocol(message: String) -> sqlx::Error {
    sqlx::Error::Protocol(message)
}

/// Binds the values in placeholder order.
fn bound<'q, DB: sqlx::Database>(query: &str, args: &[CatalogValue]) -> sqlx::query::Query<'q, DB, DB::Arguments>
where
    for<'t> i64: sqlx::Encode<'t, DB> + sqlx::Type<DB>,
    for<'t> String: sqlx::Encode<'t, DB> + sqlx::Type<DB>,
    for<'t> bool: sqlx::Encode<'t, DB> + sqlx::Type<DB>,
    for<'t> Option<String>: sqlx::Encode<'t, DB> + sqlx::Type<DB>,
{
    let mut q = sqlx::query::<DB>(AssertSqlSafe(query.to_owned()));
    for arg in args {
        q = match arg {
            CatalogValue::Null => q.bind(None::<String>),
            CatalogValue::Text(s) => q.bind(s.clone()),
            CatalogValue::Int(n) => q.bind(*n),
            CatalogValue::Bool(b) => q.bind(*b),
        };
    }
    q
}

macro_rules! impl_apply_connection {
    ($connection:ty, $database:ty, $decoder:expr) => {
        impl ApplyConnection for $connection {
            async fn execute(&mut self, statement: &str) -> Result<(), sqlx::Error> {
                sqlx::raw_sql(AssertSqlSafe(statement.to_owned())).execute(self).await.map(drop)
            }

            async fn execute_bound(&mut self, statement: &str, args: &[CatalogValue]) -> Result<(), sqlx::Error> {
                bound::<$database>(statement, args).execute(self).await.map(drop)
            }

            async fn query_bound(&mut self, query: &str, args: &[CatalogValue]) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
                let rows = bound::<$database>(query, args).fetch_all(self).await?;
                super::catalog_rows(&rows, $decoder)
            }
        }
    };
}

impl_apply_connection!(MySqlConnection, sqlx::MySql, super::mysql_value);
impl_apply_connection!(PgConnection, sqlx::Postgres, super::postgres_value);
impl_apply_connection!(SqliteConnection, sqlx::Sqlite, super::sqlite_value);

#[cfg(test)]
mod sqlite_lock_result_tests {
    use super::{Applier, ApplyClock, ApplyConnection, ApplyError, ApplyEvents, CatalogQuerier, CatalogValue, Dialect};
    use crate::test_support::impl_database_error;
    use chrono::Utc;
    use std::fmt;

    #[derive(Debug)]
    struct ResultError(i32);

    impl fmt::Display for ResultError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(f, "SQLite result {}", self.0)
        }
    }
    impl std::error::Error for ResultError {}
    impl_database_error!(ResultError, self, { "synthetic SQLite result" }, { Some(std::borrow::Cow::Owned(self.0.to_string())) });

    struct FailingBegin {
        code: i32,
    }
    impl CatalogQuerier for FailingBegin {
        async fn rows(&mut self, _query: &str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
            Ok(Vec::new())
        }
    }
    impl ApplyConnection for FailingBegin {
        async fn execute(&mut self, statement: &str) -> Result<(), sqlx::Error> {
            if statement == "BEGIN EXCLUSIVE" { Err(sqlx::Error::Database(Box::new(ResultError(self.code)))) } else { Ok(()) }
        }
        async fn execute_bound(&mut self, _statement: &str, _args: &[CatalogValue]) -> Result<(), sqlx::Error> {
            Ok(())
        }
        async fn query_bound(&mut self, query: &str, _args: &[CatalogValue]) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
            let value = match query {
                "PRAGMA foreign_keys" | "PRAGMA busy_timeout" => CatalogValue::Int(1),
                "PRAGMA legacy_alter_table" => CatalogValue::Int(0),
                "PRAGMA locking_mode" => CatalogValue::Text("normal".to_owned()),
                "SELECT COUNT(*) FROM sqlite_master" => CatalogValue::Int(0),
                _ => return Err(sqlx::Error::Protocol(format!("unexpected query {query}"))),
            };
            Ok(vec![vec![value]])
        }
    }

    struct FailingPostgresSetup;
    impl CatalogQuerier for FailingPostgresSetup {
        async fn rows(&mut self, query: &str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
            self.query_bound(query, &[]).await
        }
    }
    impl ApplyConnection for FailingPostgresSetup {
        async fn execute(&mut self, _statement: &str) -> Result<(), sqlx::Error> {
            Ok(())
        }
        async fn execute_bound(&mut self, _statement: &str, _args: &[CatalogValue]) -> Result<(), sqlx::Error> {
            Ok(())
        }
        async fn query_bound(&mut self, query: &str, _args: &[CatalogValue]) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
            if query.contains("pg_locks") {
                Ok(vec![vec![CatalogValue::Int(7), CatalogValue::Bool(false)]])
            } else if query.contains("pg_try_advisory_lock") {
                Ok(vec![vec![CatalogValue::Bool(true), CatalogValue::Int(7)]])
            } else if query.contains("current_setting('lock_timeout')") {
                Err(sqlx::Error::Protocol("lock setting read failed".into()))
            } else if query.contains("pg_advisory_unlock") {
                Ok(vec![vec![CatalogValue::Bool(false)]])
            } else {
                Err(sqlx::Error::Protocol(format!("unexpected query {query}")))
            }
        }
    }

    #[tokio::test]
    async fn lock_setup_failure_keeps_error_when_unlock_fails() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let mut connection = FailingPostgresSetup;
        let clock: &ApplyClock<'_> = &|| Utc::now();
        let events: &mut ApplyEvents<'_> = &mut |_| Ok(());
        let mut applier = Applier::new(&mut connection, Dialect::Postgres, &[], clock, events).expect("empty plan chain");
        let error = match applier.open().await {
            Err(error) => error,
            Ok(_) => panic!("settings read unexpectedly succeeded"),
        };
        match error {
            ApplyError::Cleanup { error, cleanup } => {
                assert!(error.to_string().contains("lock setting read failed"), "primary: {error}");
                assert!(cleanup.to_string().contains("advisory lock"), "cleanup: {cleanup}");
            }
            other => panic!("expected primary and unlock errors, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn command_entrypoints_share_sqlite_lock_lifecycle_for_empty_plan_chain() {
        use sqlx::Connection as _;
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let mut connection = sqlx::SqliteConnection::connect("sqlite::memory:").await.expect("SQLite memory connection");
        let clock: &ApplyClock<'_> = &|| Utc::now();
        let mut callback = |_event: &super::ApplyEvent| Ok(());
        let events: &mut ApplyEvents<'_> = &mut callback;
        super::apply(&mut connection, Dialect::Sqlite, &[], clock, events).await.expect("apply empty chain");
        super::recover(&mut connection, Dialect::Sqlite, &[], clock, events).await.expect("recover empty chain");
        super::rollback(&mut connection, Dialect::Sqlite, &[], clock, events).await.expect("rollback empty chain");
        super::finalize(&mut connection, Dialect::Sqlite, &[], clock, events).await.expect("finalize empty chain");
    }

    #[tokio::test]
    async fn begin_exclusive_maps_only_lock_errors_and_keeps_the_driver_source() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        for code in [5, 6, 261, 517, 773, 262, 518, 10, 8, 14, 23, 1] {
            let mut connection = FailingBegin { code };
            let clock: &ApplyClock<'_> = &|| Utc::now();
            let events: &mut ApplyEvents<'_> = &mut |_| Ok(());
            let mut applier = Applier::new(&mut connection, Dialect::Sqlite, &[], clock, events).expect("empty plan chain");
            let error = match applier.open().await {
                Err(error) => error,
                Ok(_) => panic!("BEGIN EXCLUSIVE unexpectedly succeeded for result {code}"),
            };
            match (code & 0xff, error) {
                (5 | 6, ApplyError::Locked { source: Some(source), .. }) => {
                    assert_eq!(source.as_database_error().and_then(|error| error.code()).as_deref(), Some(code.to_string().as_str()));
                }
                (5 | 6, other) => panic!("SQLite result {code} mapped to {other:?}, want Locked"),
                (_, ApplyError::Database(source)) => {
                    assert_eq!(source.as_database_error().and_then(|error| error.code()).as_deref(), Some(code.to_string().as_str()));
                }
                (_, other) => panic!("SQLite result {code} mapped to {other:?}, want Database"),
            }
        }
    }
}
