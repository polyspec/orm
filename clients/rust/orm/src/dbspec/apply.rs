//! Applying plan chains step by step (docs/plans.md, "Apply"): [`apply`]
//! runs the steps of the plans of a chain that the database has not applied,
//! each statement on its own with its recorded history step in the table
//! `dbspec$plans`, and verifies each plan by introspection; [`recover`]
//! continues an interrupted plan from the catalog effect of the step after
//! its recorded one; [`rollback`] undoes the last plan with its rollback
//! statements; [`finalize`] drops what the applied plans hid.

use super::{chain, introspect, manifest, plan_steps, CatalogQuerier, CatalogValue, Dialect, Effect, Plan, PlanStep};
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
    /// The event name of docs/plans.md.
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

/// One occurrence that a command reports (docs/plans.md, "Apply"). `step`
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
/// coded failures of docs/plans.md carry their code through
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
    Verify { plan: String, message: String },
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
    /// The code of docs/plans.md, or `None` for a database or event error.
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
            ApplyError::Verify { plan, message } => write!(f, "verify {plan}: {message}"),
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
            ApplyError::Event(e) => Some(e.as_ref()),
            ApplyError::Cleanup { error, .. } => Some(error.as_ref()),
            _ => None,
        }
    }
}

impl From<sqlx::Error> for ApplyError {
    fn from(e: sqlx::Error) -> Self {
        ApplyError::Database(e)
    }
}

/// 적용한 plan을 기록하는 table. dbspec 이름에는 `$`가 없으므로 사용자 table과
/// 겹치지 않고, introspection은 `dbspec$`로 시작하는 table을 빼고 읽는다.
const HISTORY_TABLE: &str = "dbspec$plans";

/// 현재 database 하나의 lock 이름. MySQL lock 이름은 64자까지이므로
/// database 이름 대신 그 SHA-256 hex 앞 51자를 붙여 64자로 만든다.
const MYSQL_LOCK: &str = "CONCAT('dbspec$plans$', LEFT(SHA2(DATABASE(), 256), 51))";

/// 현재 database의 현재 schema 하나의 advisory lock key.
const POSTGRES_LOCK: &str = "hashtext('dbspec$plans'), hashtext(current_schema())";

/// session error가 밝히는 요구. lock은 server session에 속하므로 명령은 처음부터 끝까지 다른
/// client와 나누지 않는 server session 하나에서 실행해야 한다. transaction pooler는 statement마다
/// server connection을 다시 고르므로 그 요구를 지키지 못한다.
const SESSION_REQUIREMENT: &str =
    "apply, recover, rollback and finalize need one server session of their own for the whole run: a direct or session-pooled connection";

/// 현재 server session의 id와, 그 session이 이 명령의 lock을 이미 잡고 있는지를 읽는 query.
/// lock을 잡기 전에 이미 잡혀 있으면 다른 client가 같은 server session을 쓰고 있다.
fn session_query(d: Dialect) -> String {
    match d {
        Dialect::MySql => format!("SELECT CONNECTION_ID(), COALESCE(IS_USED_LOCK({MYSQL_LOCK}) = CONNECTION_ID(), 0)"),
        _ => format!(
            "SELECT pg_backend_pid(), EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND objsubid = 2 \
             AND classid = (hashtext('{HISTORY_TABLE}')::bigint & 4294967295)::oid AND objid = (hashtext(current_schema())::bigint & 4294967295)::oid)"
        ),
    }
}

/// statement가 다른 session의 lock을 기다리는 최대 시간(docs/plans.md "Apply"의 lock 대기).
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
        (Dialect::Postgres, "table") => "SELECT COUNT(*) FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p') AND relname = $1",
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

/// Applies, step by step, the plans of the chain of `plans` that the database
/// of `connection` has not applied, up to their finalize steps; on a database
/// that has applied the whole chain it changes nothing. `dialect` must be the
/// database of the connection, `now` gives `applied_at` and `events` receives
/// every event; an error it returns stops the command at that point. When
/// restoring the session settings or SQLite foreign keys, or releasing the
/// lock, fails after a failure, the result is [`ApplyError::Cleanup`] with
/// both.
pub async fn apply<C: ApplyConnection + ?Sized>(
    connection: &mut C,
    dialect: Dialect,
    plans: &[Plan],
    now: &ApplyClock<'_>,
    events: &mut ApplyEvents<'_>,
) -> Result<(), ApplyError> {
    let mut a = Applier::new(connection, dialect, plans, now, events)?;
    let restore = a.open().await?;
    let result = a.apply_chain().await;
    a.close(result, restore).await
}

/// Continues the interrupted plan forward from the catalog effect of the step
/// after its recorded one, up to `applied`, or to `done` for a finalizing
/// plan. Without an interrupted plan it changes nothing. Failures are
/// reported as for [`apply`].
pub async fn recover<C: ApplyConnection + ?Sized>(
    connection: &mut C,
    dialect: Dialect,
    plans: &[Plan],
    now: &ApplyClock<'_>,
    events: &mut ApplyEvents<'_>,
) -> Result<(), ApplyError> {
    let mut a = Applier::new(connection, dialect, plans, now, events)?;
    let restore = a.open().await?;
    let result = a.recover_chain().await;
    a.close(result, restore).await
}

/// Undoes the last plan of the history with its rollback statements down to
/// its first step and deletes its row. An applied plan is checked for drift
/// and NULL rows first; a step without rollback stops it with
/// [`ApplyError::Irreversible`]. Without a row it changes nothing. Failures
/// are reported as for [`apply`].
pub async fn rollback<C: ApplyConnection + ?Sized>(
    connection: &mut C,
    dialect: Dialect,
    plans: &[Plan],
    now: &ApplyClock<'_>,
    events: &mut ApplyEvents<'_>,
) -> Result<(), ApplyError> {
    let mut a = Applier::new(connection, dialect, plans, now, events)?;
    let restore = a.open().await?;
    let result = a.rollback_chain().await;
    a.close(result, restore).await
}

/// Runs the finalize steps of every applied plan in chain order, dropping the
/// hidden tables and columns, and records the plans `done`. Failures are
/// reported as for [`apply`].
pub async fn finalize<C: ApplyConnection + ?Sized>(
    connection: &mut C,
    dialect: Dialect,
    plans: &[Plan],
    now: &ApplyClock<'_>,
    events: &mut ApplyEvents<'_>,
) -> Result<(), ApplyError> {
    let mut a = Applier::new(connection, dialect, plans, now, events)?;
    let restore = a.open().await?;
    let result = a.finalize_chain().await;
    a.close(result, restore).await
}

/// history table의 한 행.
struct HistoryRow {
    name: String,
    from: String,
    to: String,
    state: String,
    step: usize,
}

/// 명령이 끝에 되돌릴 session 설정.
enum Restore {
    MySql { lock_wait: i64, row_wait: i64 },
    Postgres { lock_timeout: String },
    Sqlite { foreign_keys: i64, legacy: i64, mode: String, busy: i64 },
}

/// 명령 한 번의 상태.
struct Applier<'a, C: ?Sized> {
    c: &'a mut C,
    d: Dialect,
    now: &'a ApplyClock<'a>,
    events: &'a mut ApplyEvents<'a>,
    chain: Vec<&'a Plan>,
    history: Vec<HistoryRow>,
    /// lock을 잡은 server session의 id(MySQL CONNECTION_ID, PostgreSQL pg_backend_pid).
    server_session: i64,
}

/// dialect의 식별자 quote.
fn quote(d: Dialect, name: &str) -> String {
    match d {
        Dialect::MySql => format!("`{name}`"),
        _ => format!("\"{name}\""),
    }
}

fn hash_or_empty(hash: Option<&str>) -> &str {
    hash.unwrap_or("empty")
}

/// 첫 finalize step의 index.
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

    fn placeholder(&self, n: usize) -> String {
        match self.d {
            Dialect::Postgres => format!("${n}"),
            _ => "?".to_owned(),
        }
    }

    /// 한 row를 돌려주는 query의 값들.
    async fn row(&mut self, query: &str, args: &[CatalogValue]) -> Result<Vec<CatalogValue>, ApplyError> {
        let rows = self.c.query_bound(query, args).await?;
        match <[Vec<CatalogValue>; 1]>::try_from(rows) {
            Ok([row]) => Ok(row),
            Err(rows) => Err(ApplyError::Database(protocol(format!("{query} returned {} rows; want one", rows.len())))),
        }
    }

    /// 한 값만 돌려주는 query의 값.
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

    /// lock을 잡기 전에 server session의 id를 기억한다. 그 session이 lock을 이미 잡고 있으면 다른
    /// client가 같은 server session을 쓰는 것이므로 session error다.
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

    /// current가 lock을 잡은 server session인지 확인한다. 다르면 `plan`의 step 앞에서(None이면
    /// lock에서) session error다.
    fn same_session(&self, plan: Option<(&Plan, usize)>, current: i64) -> Result<(), ApplyError> {
        if current == self.server_session {
            return Ok(());
        }
        Err(ApplyError::Session {
            plan: plan.map(|(p, i)| (p.name().to_owned(), i)),
            message: format!("the connection moved from server session {} to {current}; {SESSION_REQUIREMENT}", self.server_session),
        })
    }

    /// lock query의 결과 row(lock 결과, server session id)를 나눈다.
    fn lock_row(query: &str, row: Vec<CatalogValue>) -> Result<(CatalogValue, i64), ApplyError> {
        match <[CatalogValue; 2]>::try_from(row) {
            Ok([got, CatalogValue::Int(current)]) => Ok((got, current)),
            Ok(row) => Err(ApplyError::Database(protocol(format!("{query} returned {row:?}")))),
            Err(row) => Err(ApplyError::Database(protocol(format!("{query} returned {} values; want two", row.len())))),
        }
    }

    /// dialect의 lock을 잡고 session 설정을 바꾼다. 실패하면 그때까지 바꾼 것을
    /// 되돌리고 놓은 뒤 error를 돌려준다.
    async fn open(&mut self) -> Result<Restore, ApplyError> {
        match self.d {
            Dialect::MySql => {
                self.open_session().await?;
                // GET_LOCK의 NULL은 lock을 기다리던 중의 error다.
                let query = format!("SELECT GET_LOCK({MYSQL_LOCK}, 0), CONNECTION_ID()");
                let (got, current) = Self::lock_row(&query, self.row(&query, &[]).await?)?;
                match got {
                    CatalogValue::Int(1) => {}
                    CatalogValue::Int(0) => {
                        return Err(ApplyError::Locked { message: format!("another session holds the {HISTORY_TABLE} lock of this database"), source: None })
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
                    Err(e) => {
                        let released = self.release().await;
                        Err(settle(Err(e), released).expect_err("a failure stays a failure"))
                    }
                }
            }
            Dialect::Postgres => {
                self.open_session().await?;
                // current_schema()가 NULL이면 결과도 NULL이며 error다.
                let query = format!("SELECT pg_try_advisory_lock({POSTGRES_LOCK}), pg_backend_pid()");
                let (got, current) = Self::lock_row(&query, self.row(&query, &[]).await?)?;
                match got {
                    CatalogValue::Bool(true) => {}
                    CatalogValue::Bool(false) => {
                        return Err(ApplyError::Locked {
                            message: format!("another session holds the {HISTORY_TABLE} advisory lock of this schema"),
                            source: None,
                        })
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
                    Err(e) => {
                        let released = self.release().await;
                        Err(settle(Err(e), released).expect_err("a failure stays a failure"))
                    }
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
                        return Err(ApplyError::Locked { message: "another connection holds the SQLite database".to_owned(), source: Some(e) });
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

    /// MySQL과 PostgreSQL의 lock을 놓는다. PostgreSQL에서 아무것도 풀지 않은 unlock은 error다.
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

    /// session 설정을 되돌리고 lock을 놓는다. 정리의 실패는 앞선 error와 함께 알린다.
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
                // locking mode를 되돌린 뒤 한 번 읽어야 exclusive lock이 풀린다.
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
        let position = self.position().await?;
        if position == 0 {
            return Ok(());
        }
        let p = self.chain[position - 1];
        let (state, step) = self.row_of(p);
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
        let position = self.position().await?;
        if position == 0 {
            return Ok(());
        }
        let p = self.chain[position - 1];
        let (state, step) = self.row_of(p);
        let steps = self.steps(p)?;
        let applied = state == APPLIED || state == DONE;
        let k = if applied {
            self.verify(Some(p.to())).await.map_err(|message| ApplyError::Drift { message })?;
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
        self.verify(p.from()).await.map_err(|message| ApplyError::Verify { plan: p.name().to_owned(), message })?;
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

    fn row_of(&self, p: &Plan) -> (String, usize) {
        self.history.iter().find(|r| r.name == p.name()).map(|r| (r.state.clone(), r.step)).expect("a recorded plan has a history row")
    }

    /// history table을 없을 때 만든다.
    async fn create_history(&mut self) -> Result<(), ApplyError> {
        let (integer, text, tail) = match self.d {
            Dialect::MySql => ("INT", "varchar(71) CHARACTER SET ascii COLLATE ascii_bin", " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin"),
            _ => ("integer", "varchar(71)", ""),
        };
        let statement = format!(
            "CREATE TABLE IF NOT EXISTS {} ({} {text} NOT NULL, {} {text} NOT NULL, {} {text} NOT NULL, {} {text} NOT NULL, {} {integer} NOT NULL, {} {integer} NOT NULL, {} {text} NOT NULL, PRIMARY KEY ({})){tail}",
            self.q(HISTORY_TABLE),
            self.q("name"),
            self.q("from_hash"),
            self.q("to_hash"),
            self.q("state"),
            self.q("step"),
            self.q("steps"),
            self.q("applied_at"),
            self.q("name"),
        );
        self.exec(&statement).await
    }

    async fn read_history(&mut self) -> Result<(), ApplyError> {
        self.create_history().await?;
        let query = format!(
            "SELECT {}, {}, {}, {}, {} FROM {}",
            self.q("name"),
            self.q("from_hash"),
            self.q("to_hash"),
            self.q("state"),
            self.q("step"),
            self.q(HISTORY_TABLE)
        );
        let rows = self.c.query_bound(&query, &[]).await?;
        self.history = rows
            .into_iter()
            .map(|row| match <[CatalogValue; 5]>::try_from(row) {
                Ok([CatalogValue::Text(name), CatalogValue::Text(from), CatalogValue::Text(to), CatalogValue::Text(state), CatalogValue::Int(step)]) => {
                    let step = usize::try_from(step).map_err(|_| ApplyError::Database(protocol(format!("{HISTORY_TABLE} row {name} has the step {step}"))))?;
                    Ok(HistoryRow { name, from, to, state, step })
                }
                Ok(other) => Err(ApplyError::Database(protocol(format!("{HISTORY_TABLE} has the row {other:?}")))),
                Err(other) => Err(ApplyError::Database(protocol(format!("{HISTORY_TABLE} has the row {other:?}")))),
            })
            .collect::<Result<_, _>>()?;
        Ok(())
    }

    /// history를 읽어 기록된 plan 수를 돌려준다. 기록은 chain의 앞부분이어야 하고,
    /// 마지막 앞의 row는 applied나 done이어야 한다.
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

    /// 중단된 plan이 없고 catalog가 기록한 schema와 같을 때 기록된 plan 수를 돌려준다.
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
        self.verify(want).await.map_err(|message| ApplyError::Drift { message })?;
        Ok(position)
    }

    /// database의 introspection이 `want` schemaHash(None이면 빈 database)이고
    /// 미지원 객체가 없는지 확인한다. 다르면 그 차이를 돌려준다.
    async fn verify(&mut self, want: Option<&str>) -> Result<(), String> {
        let introspection = introspect(&mut *self.c, self.d, "schema").await.map_err(|e| e.to_string())?;
        if let Some(u) = introspection.unsupported.first() {
            return Err(format!(
                "the database has {} objects that dbspec cannot express, first {} {} {}: {}",
                introspection.unsupported.len(),
                u.kind,
                u.table,
                u.name,
                u.reason
            ));
        }
        let got = if introspection.document.tables.is_empty() {
            None
        } else {
            let m = manifest(&[&introspection.document]).map_err(|diagnostics| format!("the introspected schema is invalid: {diagnostics:?}"))?;
            Some(m.schema_hash)
        };
        if got.as_deref() != want {
            return Err(format!("the database is at {}, not {}", hash_or_empty(got.as_deref()), hash_or_empty(want)));
        }
        Ok(())
    }

    /// chain에서 plan의 앞 plan target을 source로 step을 쓴다.
    fn steps(&self, p: &Plan) -> Result<Vec<PlanStep>, ApplyError> {
        let index = self.chain.iter().position(|c| std::ptr::eq(*c, p));
        let source = index.filter(|&i| i > 0).map(|i| self.chain[i - 1].schema());
        plan_steps(source, p, self.d).map_err(|diagnostics| ApplyError::Chain { plan: Some(p.name().to_owned()), message: diagnostics[0].message.clone() })
    }

    /// 중단된 row의 step을 catalog의 효과로 정한다. forward이면 앞으로, 아니면 뒤로
    /// 이어 갈 위치다(docs/plans.md "Apply"의 recover).
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
        // 앞으로 갈 때 repeat step은 다시 실행하고, 뒤로 갈 때는 그 rollback을 다시 실행한다.
        let took = held || (!forward && e.kind == "repeat");
        Ok(match (rolling, took) {
            (true, true) => k,
            (true, false) => k - 1,
            (false, true) => k + 1,
            (false, false) => k,
        })
    }

    /// plan의 row를 state와 step으로 쓴다. row가 없으면 만든다.
    async fn record(&mut self, p: &Plan, state: &str, step: usize, steps: usize) -> Result<(), ApplyError> {
        let count = |n: usize| i64::try_from(n).map_err(|_| ApplyError::Database(protocol(format!("the step {n} does not fit a history row"))));
        if !self.history.iter().any(|r| r.name == p.name()) {
            let placeholders: Vec<String> = (1..=7).map(|n| self.placeholder(n)).collect();
            let insert = format!(
                "INSERT INTO {} ({}, {}, {}, {}, {}, {}, {}) VALUES ({})",
                self.q(HISTORY_TABLE),
                self.q("name"),
                self.q("from_hash"),
                self.q("to_hash"),
                self.q("state"),
                self.q("step"),
                self.q("steps"),
                self.q("applied_at"),
                placeholders.join(", ")
            );
            // applied_at은 tool clock의 UTC 시각을 소수 여섯 자리로 버린 text다 (docs/plans.md "Apply").
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
        let step = i64::try_from(step).map_err(|_| ApplyError::Database(protocol(format!("the step {step} does not fit a history row"))))?;
        let update =
            format!("UPDATE {} SET {} = {} WHERE {} = {}", self.q(HISTORY_TABLE), self.q("step"), self.placeholder(1), self.q("name"), self.placeholder(2));
        Ok(self.c.execute_bound(&update, &[CatalogValue::Int(step), CatalogValue::Text(p.name().to_owned())]).await?)
    }

    /// plan 하나를 finalize step 앞까지 적용하고 검증한다.
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

    /// step start부터 finalize step 앞까지 실행하고 검증한 뒤 row를 applied로 바꾼다.
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
        self.verify(Some(p.to())).await.map_err(|message| ApplyError::Verify { plan: p.name().to_owned(), message })?;
        self.emit(ApplyEventKind::Verified, p, 0, steps.len(), "")?;
        self.record(p, APPLIED, end, steps.len()).await?;
        self.emit(ApplyEventKind::Done, p, 0, steps.len(), "")
    }

    /// finalize step을 start부터 실행하고 row를 done으로 바꾼다.
    async fn finalize_from(&mut self, p: &Plan, steps: &[PlanStep], start: usize) -> Result<(), ApplyError> {
        for (i, s) in steps.iter().enumerate().skip(start) {
            self.run(p, steps.len(), i, &s.statement).await?;
            self.set_step(p, i + 1).await?;
        }
        self.record(p, DONE, steps.len(), steps.len()).await?;
        self.emit(ApplyEventKind::Done, p, 0, steps.len(), "")
    }

    /// step i의 statement 하나를 event와 함께 실행한다. statement 앞에서 server session을
    /// 확인한다(SQLite connection은 file 하나의 connection이다).
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

    /// SQLite에서 foreign key를 어기는 row가 없는지 확인한다.
    async fn foreign_key_check(&mut self, p: &Plan) -> Result<(), ApplyError> {
        if self.d != Dialect::Sqlite {
            return Ok(());
        }
        match self.integer("SELECT COUNT(*) FROM pragma_foreign_key_check").await? {
            0 => Ok(()),
            broken => Err(ApplyError::Verify { plan: p.name().to_owned(), message: format!("{broken} rows break a foreign key") }),
        }
    }

    /// 적용한 plan의 rollback이 non-null로 되돌릴 column의 NULL row를 default로
    /// 채우거나, default가 없으면 nulls error로 멈춘다(docs/plans.md "Steps").
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

    /// 효과가 지금 database에 있는지 알려 준다. 읽지 못하면 step의 failed error다.
    async fn effect(&mut self, p: &Plan, step: usize, e: Option<&Effect>) -> Result<bool, ApplyError> {
        let e = e.expect("a step with a restore statement has its effect");
        effect_holds(&mut *self.c, self.d, e).await.map_err(|source| ApplyError::Failed { plan: p.name().to_owned(), step, statement: String::new(), source })
    }

    fn emit(&mut self, kind: ApplyEventKind, p: &Plan, step: usize, steps: usize, statement: &str) -> Result<(), ApplyError> {
        (self.events)(&ApplyEvent { kind, plan: p.name().to_owned(), step, steps, statement: statement.to_owned() }).map_err(ApplyError::Event)
    }
}

fn irreversible(p: &Plan, steps: &[PlanStep], i: usize) -> ApplyError {
    let message = if steps[i].finalize { "a finalize step has no rollback".to_owned() } else { steps[i].irreversible.clone() };
    ApplyError::Irreversible { plan: p.name().to_owned(), step: i, message }
}

/// `result`에 정리 statement의 결과를 더한다. 앞선 error가 있으면 정리 실패를
/// 그 error와 함께 돌려준다.
fn settle(result: Result<(), ApplyError>, cleanup: Result<(), ApplyError>) -> Result<(), ApplyError> {
    match (result, cleanup) {
        (result, Ok(())) => result,
        (Ok(()), Err(e)) => Err(e),
        (Err(error), Err(cleanup)) => Err(ApplyError::Cleanup { error: Box::new(error), cleanup: Box::new(cleanup) }),
    }
}

/// 기대한 모양이 아닌 결과의 error.
fn protocol(message: String) -> sqlx::Error {
    sqlx::Error::Protocol(message)
}

/// 값을 placeholder 순서로 bind한다.
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

impl ApplyConnection for MySqlConnection {
    async fn execute(&mut self, statement: &str) -> Result<(), sqlx::Error> {
        sqlx::raw_sql(AssertSqlSafe(statement.to_owned())).execute(self).await.map(drop)
    }

    async fn execute_bound(&mut self, statement: &str, args: &[CatalogValue]) -> Result<(), sqlx::Error> {
        bound::<sqlx::MySql>(statement, args).execute(self).await.map(drop)
    }

    async fn query_bound(&mut self, query: &str, args: &[CatalogValue]) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        let rows = bound::<sqlx::MySql>(query, args).fetch_all(self).await?;
        rows.iter().map(|row| (0..sqlx::Row::len(row)).map(|i| super::mysql_value(row, i)).collect()).collect()
    }
}

impl ApplyConnection for PgConnection {
    async fn execute(&mut self, statement: &str) -> Result<(), sqlx::Error> {
        sqlx::raw_sql(AssertSqlSafe(statement.to_owned())).execute(self).await.map(drop)
    }

    async fn execute_bound(&mut self, statement: &str, args: &[CatalogValue]) -> Result<(), sqlx::Error> {
        bound::<sqlx::Postgres>(statement, args).execute(self).await.map(drop)
    }

    async fn query_bound(&mut self, query: &str, args: &[CatalogValue]) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        let rows = bound::<sqlx::Postgres>(query, args).fetch_all(self).await?;
        rows.iter().map(|row| (0..sqlx::Row::len(row)).map(|i| super::postgres_value(row, i)).collect()).collect()
    }
}

impl ApplyConnection for SqliteConnection {
    async fn execute(&mut self, statement: &str) -> Result<(), sqlx::Error> {
        sqlx::raw_sql(AssertSqlSafe(statement.to_owned())).execute(self).await.map(drop)
    }

    async fn execute_bound(&mut self, statement: &str, args: &[CatalogValue]) -> Result<(), sqlx::Error> {
        bound::<sqlx::Sqlite>(statement, args).execute(self).await.map(drop)
    }

    async fn query_bound(&mut self, query: &str, args: &[CatalogValue]) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        let rows = bound::<sqlx::Sqlite>(query, args).fetch_all(self).await?;
        rows.iter().map(|row| (0..sqlx::Row::len(row)).map(|i| super::sqlite_value(row, i)).collect()).collect()
    }
}
