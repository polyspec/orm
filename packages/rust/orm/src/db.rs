//! A database connection: the pool, the plan cache, and the executor that
//! runs a statement on the pool or on an active transaction.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{FixedOffset, NaiveDateTime, Utc};
use sqlx::mysql::{MySqlConnectOptions, MySqlPool};
use sqlx::postgres::{PgConnectOptions, PgPool};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};

use crate::driver::{
    arg_types, exec_mysql, exec_mysql_pool, exec_pg, exec_pg_pool, exec_sqlite, exec_sqlite_pool, fetch_mysql, fetch_mysql_pool, fetch_pg, fetch_pg_pool,
    fetch_sqlite, fetch_sqlite_pool, masked, param_arg, statement, Target, TxInner,
};
pub use crate::driver::{stale_plan, NOW_MASK};
use crate::engine::{self, Dialect};
use crate::events::{statement_kind, Sent, Subscribers, KIND_UTILITY};
use crate::markdown::{open_markdown, parse_markdown_dsn, MarkdownDsn, MarkdownPool};
use crate::plan::{Plan, Step};
use crate::request::Req;
use crate::row::DriverRow;
use crate::schema::Schema;
use crate::tx::{AuditKey, TxShared};
use crate::value::Param;
use crate::{codes, Error, Result};

/// The audit source of a connection: it returns the audit values of the
/// current request, column names and values of the audit record table, such as
/// the account and the request id. A transaction with `audit(values)` calls it
/// once before it begins; an error fails the transaction. The ORM writes no
/// audit value of its own.
pub type AuditSource = Arc<dyn Fn() -> Result<Vec<(String, Param)>> + Send + Sync>;

/// The request hook of a handle (docs/operations/usage.md "Request hook"): it receives each
/// request of the handle right before the client plans it, changes it in place
/// and adds parameters with [`RequestParams::add`]. An error it returns fails the
/// operation unchanged, before any statement.
pub type RequestHook = Arc<dyn Fn(&mut crate::ir::Request, &mut RequestParams) -> Result<()> + Send + Sync>;

/// The parameters of the request a [`RequestHook`] receives: it reads the values that the request binds and adds
/// parameters.
pub struct RequestParams {
    params: Vec<Param>,
}

impl RequestParams {
    /// Returns the value of the parameter at `index`, or `None` past the parameters.
    pub fn get(&self, index: usize) -> Option<&Param> {
        self.params.get(index)
    }

    /// Appends `value` to the request parameters and returns its index.
    pub fn add(&mut self, value: impl Into<Param>) -> usize {
        self.params.push(value.into());
        self.params.len() - 1
    }
}

/// Applies the handle's request hook to req. Does nothing if there is no hook. The hook receives the request and
/// the parameters and may change them; n_params is then the number of parameters. A hook error is returned as is.
pub(crate) fn apply_request_hook(handle: &Db, req: &mut Req) -> Result<()> {
    let Some(hook) = &handle.hook else { return Ok(()) };
    req.ir.n_params = req.params.len();
    let mut params = RequestParams { params: std::mem::take(&mut req.params) };
    let result = hook(&mut req.ir, &mut params);
    req.params = params.params;
    req.ir.n_params = req.params.len();
    result
}

/// The connection configuration: declared, never discovered.
#[derive(Clone)]
pub struct Config {
    /// Key of aes_version for aes writes; empty takes `aes_keys[aes_version]`
    /// when a key ring is configured.
    pub aes_key: String,
    pub blind_index_key: String,
    pub aes_version: i32,
    pub aes_keys: BTreeMap<i32, String>,
    pub plan_cache_size: usize,
    pub statement_cache_size: usize,
    /// Bound of every statement of the connection in milliseconds; zero keeps
    /// the server default.
    pub statement_timeout_ms: u32,
    /// Maximum idle connections of the pool; zero keeps up to the pool size.
    pub pool_idle_size: u32,
    /// Lifetime of a pool connection in milliseconds; zero keeps the pool
    /// default of 30 minutes.
    pub pool_lifetime_ms: u32,
    /// The audit values of the transactions that record an audit; `None`
    /// fails such a transaction with CONFIG.
    pub audit_source: Option<AuditSource>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            aes_key: String::new(),
            blind_index_key: String::new(),
            aes_version: 1,
            aes_keys: BTreeMap::new(),
            statement_timeout_ms: 0,
            pool_idle_size: 0,
            pool_lifetime_ms: 0,
            plan_cache_size: 256,
            statement_cache_size: 256,
            audit_source: None,
        }
    }
}

const SQLITE_DATETIME: &str = "%Y-%m-%d %H:%M:%S%.6f";

/// The time zone of a connection. Every connection reads and writes datetime
/// values in UTC (docs/spec/dialects.md "Date and time").
#[derive(Clone, Copy, Debug)]
pub struct Zone;

impl Zone {
    /// The `timezone` parameter accepts only UTC.
    fn parse(value: &str) -> Result<Zone> {
        match value {
            "UTC" | "+00:00" => Ok(Zone),
            _ => Err(Error::Config(format!("dsn timezone {value}: every connection reads and writes datetime values in UTC"))),
        }
    }

    /// The current time in the zone.
    pub fn now(&self) -> chrono::DateTime<FixedOffset> {
        self.at(Utc::now())
    }

    /// An instant in the zone.
    pub fn at(&self, t: chrono::DateTime<Utc>) -> chrono::DateTime<FixedOffset> {
        t.fixed_offset()
    }

    /// The instant of a wall-clock time in the zone.
    pub fn instant(&self, t: NaiveDateTime) -> Option<chrono::DateTime<Utc>> {
        Some(t.and_utc())
    }

    /// An instant as wall-clock time in the zone.
    pub fn local(&self, t: chrono::DateTime<Utc>) -> NaiveDateTime {
        t.naive_utc()
    }
}

/// The connection options selected by a DSN URI.
pub enum ConnectOptions {
    MySql(MySqlConnectOptions),
    Postgres(PgConnectOptions),
    Sqlite(SqliteConnectOptions),
    /// A corpus that a flowmark server serves (docs/spec/protocol.md §5 "Markdown connections").
    Markdown(MarkdownDsn),
}

/// A DSN URI split into driver options and the connection time zone. The
/// scheme selects the database; the `timezone` parameter accepts only UTC.
pub struct ParsedDsn {
    pub options: ConnectOptions,
    pub zone: Zone,
}

impl ParsedDsn {
    /// The database whose SQL the connection runs: a corpus that a flowmark server serves runs SQL in SQLite's dialect (DIA-185).
    pub fn sql_driver(&self) -> &'static str {
        match self.options {
            ConnectOptions::Markdown(_) => "sqlite",
            _ => self.driver(),
        }
    }

    pub fn driver(&self) -> &'static str {
        match self.options {
            ConnectOptions::MySql(_) => "mysql",
            ConnectOptions::Postgres(_) => "postgres",
            ConnectOptions::Sqlite(_) => "sqlite",
            ConnectOptions::Markdown(_) => "markdown",
        }
    }
}

/// Milliseconds a SQLite connection waits for a lock when the DSN sets no `_pragma=busy_timeout(ms)`.
const SQLITE_BUSY_TIMEOUT_MS: u64 = 5000;

/// Percent-decodes the DSN path as UTF-8. A `%` without two hex digits, a NUL byte, or a non-UTF-8 result is another
/// error; it is `CONFIG` because it would point at a file or corpus. `scheme` is the DSN the error names.
fn decoded_path(raw: &str, scheme: &str) -> Result<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let digit = |at: usize| bytes.get(at).and_then(|&b| char::from(b).to_digit(16));
        match (digit(i + 1), digit(i + 2)) {
            (Some(high), Some(low)) => out.push((high * 16 + low) as u8),
            _ => return Err(Error::Config(format!("{scheme} DSN path has a % without two hexadecimal digits"))),
        }
        i += 3;
    }
    if out.contains(&0) {
        return Err(Error::Config(format!("{scheme} DSN path must not contain a NUL byte")));
    }
    String::from_utf8(out).map_err(|error| Error::Config(format!("{scheme} DSN path must be UTF-8 after percent-decoding: {error}")))
}

/// Parses a DSN URI.
pub fn parse_dsn(dsn: &str) -> Result<ParsedDsn> {
    let bad = |msg: String| Error::Config(msg);
    let url = url::Url::parse(dsn).map_err(|error| bad(format!("dsn must be a URI using mysql://, postgres://, sqlite://, or markdown://: {error}")))?;
    let mut zone_text = None;
    let mut pragmas = Vec::new();
    let mut rest = url.clone();
    rest.set_query(None);
    let mut pairs = Vec::new();
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "timezone" => zone_text = Some(v.into_owned()),
            "_pragma" if matches!(url.scheme(), "sqlite" | "markdown") => pragmas.push(v.into_owned()),
            "_txlock" if url.scheme() == "sqlite" => {
                return Err(bad("sqlite DSN does not accept _txlock; write transactions begin with BEGIN IMMEDIATE".into()));
            }
            _ => pairs.push((k.into_owned(), v.into_owned())),
        }
    }
    if !pairs.is_empty() {
        rest.query_pairs_mut().extend_pairs(pairs.iter());
    }
    let zone = match &zone_text {
        Some(z) => Zone::parse(z)?,
        None => Zone,
    };
    let sqlx_err = |e: sqlx::Error| Error::Config(format!("dsn: {e}"));
    let options = match url.scheme() {
        "mysql" => {
            if url.host_str().unwrap_or("").is_empty() || url.path().trim_matches('/').is_empty() {
                return Err(bad("mysql DSN must include host and database".into()));
            }
            if pairs.iter().any(|(key, _)| key == "ssl-mode") {
                if url.host_str().is_some_and(|host| host.trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>().is_ok()) {
                    return Err(bad("mysql DSN ssl-mode requires a host name, not an IP address".into()));
                }
                if pairs.iter().any(|(key, _)| key == "socket") {
                    return Err(bad("mysql DSN ssl-mode requires TCP and does not accept socket".into()));
                }
            }
            // sqlx sends SET NAMES utf8mb4 when it connects, with no collation, which a pooler in front of the server may not
            // know (ProxySQL refuses utf8mb4_0900_bin with 1115): a text column that the renderer writes compares under its
            // own utf8mb4_0900_bin, and SQL that compares text with no such column states COLLATE utf8mb4_0900_bin (DIA-202).
            let options = MySqlConnectOptions::from_str(rest.as_str()).map_err(sqlx_err)?.timezone(Some("+00:00".to_owned())).charset("utf8mb4");
            // A DSN without ssl-mode connects without TLS, also to a server that offers it (CFG-44): sqlx would otherwise
            // take TLS whenever the server offers it, with no check of its certificate. A named ssl-mode reaches sqlx (CFG-20).
            ConnectOptions::MySql(if pairs.iter().any(|(key, _)| key == "ssl-mode") { options } else { options.ssl_mode(sqlx::mysql::MySqlSslMode::Disabled) })
        }
        "postgres" => {
            let host = url.host_str().unwrap_or("").to_owned() + &pairs.iter().filter(|(k, _)| k == "host").map(|(_, v)| v.clone()).collect::<String>();
            if host.is_empty() || url.path().trim_matches('/').is_empty() {
                return Err(bad("postgres DSN must include host and database".into()));
            }
            // The server default extra_float_digits of PostgreSQL 12 and later
            // prints float8 values exactly, and a pooler rejects a startup
            // parameter it does not track, so the connection sends none.
            let o = PgConnectOptions::from_str(rest.as_str()).map_err(sqlx_err)?.extra_float_digits(None).options([("timezone", "UTC")]);
            ConnectOptions::Postgres(o)
        }
        "sqlite" => {
            let path = decoded_path(url.path(), "sqlite")?;
            if !path.starts_with('/') || path.len() < 2 {
                return Err(bad("sqlite DSN must include an absolute database path".into()));
            }
            let mut o = SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true)
                .foreign_keys(true)
                .busy_timeout(std::time::Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS));
            for p in pragmas {
                let (name, value) =
                    p.strip_suffix(')').and_then(|x| x.split_once('(')).ok_or_else(|| bad(format!("sqlite DSN _pragma {p:?} must be name(value)")))?;
                o = if name == "busy_timeout" {
                    let ms: u64 = value.parse().map_err(|error| bad(format!("sqlite busy_timeout {value:?}: {error}")))?;
                    o.busy_timeout(std::time::Duration::from_millis(ms))
                } else {
                    o.pragma(name.to_owned(), value.to_owned())
                };
            }
            ConnectOptions::Sqlite(o)
        }
        "markdown" => ConnectOptions::Markdown(parse_markdown_dsn(&url, &decoded_path(url.path(), "markdown")?, &pairs, &pragmas)?),
        other => return Err(bad(format!("unsupported DSN scheme {other:?}; want mysql, postgres, sqlite, or markdown"))),
    };
    Ok(ParsedDsn { options, zone })
}

/// The session sql_mode of every MySQL connection, so that a coercion, truncation
/// or grouping result does not depend on the server's setting
/// (case mysql_session_settings of contracts/fixtures/dsn_connection, docs/spec/config.md "Runtime connection").
const MYSQL_SQL_MODE: &str = "STRICT_ALL_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";

/// Whether a SQLite connection is inside a transaction. SQLite rolls a transaction back by itself after some errors, such
/// as `RAISE(ROLLBACK)` or an I/O error, and a ROLLBACK then fails with "no transaction is active"; so a transaction is
/// rolled back only while this is true (INT-155). sqlx exposes no such state, so it is read from `sqlite3_get_autocommit`.
#[allow(unsafe_code, reason = "sqlx exposes no autocommit state, so it is read through the C function sqlite3_get_autocommit on the raw handle")]
pub async fn sqlite_in_transaction(connection: &mut sqlx::SqliteConnection) -> std::result::Result<bool, sqlx::Error> {
    let mut handle = connection.lock_handle().await?;
    // SAFETY: the locked handle is an open connection that no other caller uses until the lock is dropped.
    Ok(unsafe { libsqlite3_sys::sqlite3_get_autocommit(handle.as_raw_handle().as_ptr()) } == 0)
}

/// The connection pool of a database, or of the flowmark server connections of
/// a markdown corpus.
#[derive(Clone)]
pub enum Pool {
    MySql(MySqlPool),
    Postgres(PgPool),
    Sqlite(SqlitePool),
    Markdown(Arc<MarkdownPool>),
}

impl Pool {
    /// The number of idle connections.
    fn num_idle(&self) -> usize {
        match self {
            Pool::MySql(p) => p.num_idle(),
            Pool::Postgres(p) => p.num_idle(),
            Pool::Sqlite(p) => p.num_idle(),
            Pool::Markdown(p) => p.stats().idle as usize,
        }
    }

    /// Closes the connections of the pool: those in use close as they come back.
    pub async fn close(&self) {
        match self {
            Pool::MySql(pool) => pool.close().await,
            Pool::Postgres(pool) => pool.close().await,
            Pool::Sqlite(pool) => pool.close().await,
            Pool::Markdown(pool) => pool.close(),
        }
    }
}

static NEXT_DB: AtomicU64 = AtomicU64::new(1);

pub(crate) struct DbInner {
    pub(crate) id: u64,
    pub(crate) pool: Pool,
    /// Held while the connections beyond the idle size close, so that two ends of work do not close the same surplus twice.
    idle_trim: tokio::sync::Mutex<()>,
    /// The PostgreSQL options of the pool, which a LISTEN subscription connects with; None on other databases.
    pub(crate) listen: Option<sqlx::postgres::PgConnectOptions>,
    /// The dialect the connection plans for: SQLite's on a markdown connection, whose server runs SQL in SQLite's dialect (DIA-185).
    pub(crate) dialect: Option<Dialect>,
    /// The server of a mysql connection, read once by `VERSION()` when the connection opens, never by the handshake (DIA-201);
    /// MySQL on every other database.
    pub(crate) server: crate::MySqlServer,
    pub(crate) cfg: Config,
    pub(crate) zone: Zone,
    plans: Mutex<HashMap<u64, Arc<Plan>>>,
    plan_order: Mutex<VecDeque<u64>>,
    /// The manifest hash of the set registered on this connection.
    pub(crate) sets: std::sync::RwLock<std::collections::HashSet<String>>,
    /// The schema of the registered set. Audit records are inserted with the set that has that table.
    pub(crate) schemas: std::sync::RwLock<Vec<&'static Schema>>,
    pub(crate) closed: AtomicBool,
    pub(crate) sqlite_lock_ready: AtomicBool,
    /// The connection's statement event subscribers and transaction number. All clones of the connection share them.
    pub(crate) subscribers: Subscribers,
    /// The test fault set by `polyspec_orm::testing::fail_next_rollback`. The feature
    /// Can be set only in builds with `test-faults`.
    pub(crate) rollback_fault: AtomicBool,
    /// The test fault set by `polyspec_orm::testing::fail_next_statement`. The feature
    /// Present only in builds with `test-faults`.
    #[cfg(feature = "test-faults")]
    pub(crate) statement_fault: Mutex<Option<crate::testing::StatementFault>>,
    /// The statement gate set by `polyspec_orm::testing::hold_next_statement`. Present only in builds with `test-faults`.
    #[cfg(feature = "test-faults")]
    pub(crate) statement_gate: Mutex<Option<crate::testing::StatementGate>>,
    /// The executor clock pinned by `polyspec_orm::testing::fix_clock` (`YYYY-MM-DD HH:MM:SS.ffffff`).
    /// Present only in builds with feature `test-faults`.
    #[cfg(feature = "test-faults")]
    pub(crate) fixed_clock: Mutex<Option<String>>,
    /// The affected count of the connection's last successful write result. Read by `polyspec_orm::testing::last_affected`.
    /// Present only in builds with feature `test-faults`.
    #[cfg(feature = "test-faults")]
    pub(crate) last_affected: Mutex<Option<u64>>,
}

/// A database connection. Cloning is cheap and keeps the identity.
#[derive(Clone)]
pub struct Db {
    pub(crate) inner: Arc<DbInner>,
    /// This handle's request hook. Not shared with other handles of the connection.
    pub(crate) hook: Option<RequestHook>,
}

/// The connection pool state.
/// Requirements: INT-79.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DbStats {
    /// The pool size the connection was opened with.
    pub max_open_connections: u32,
    pub open_connections: u32,
    /// The connections currently checked out of the pool.
    pub in_use: u32,
    pub idle: u32,
}

pub(crate) fn pool_in_use(open: u32, idle: u32) -> u32 {
    open.checked_sub(idle).expect("idle connections cannot exceed open connections")
}

/// The maximum of open connections when `Db::connect` receives a pool size of
/// zero; the Go and TypeScript clients use the same value.
const DEFAULT_POOL_SIZE: u32 = 10;

/// The connection a pool belongs to, set once the connection exists. The
/// release hook of the pool reads its idle count through it.
type PoolOwner = Arc<std::sync::OnceLock<std::sync::Weak<DbInner>>>;

/// The pool options of one driver: at most `size` open connections, at most
/// `idle` idle connections, and a connection lifetime of `lifetime_ms`
/// milliseconds when it is not zero.
/// Closes the idle connections of `pool` beyond `idle`.
async fn close_idle_beyond<DB: sqlx::Database>(pool: &sqlx::Pool<DB>, idle: usize) {
    while pool.num_idle() > idle {
        let Some(connection) = pool.try_acquire() else { return };
        // A connection that fails to close is gone from the pool as well, so the loop goes on.
        if connection.close().await.is_err() {
            continue;
        }
    }
}

fn pool_options<DB: sqlx::Database>(size: u32, idle: u32, lifetime_ms: u32, owner: &PoolOwner) -> sqlx::pool::PoolOptions<DB> {
    let mut options = sqlx::pool::PoolOptions::<DB>::new().max_connections(size);
    if lifetime_ms > 0 {
        options = options.max_lifetime(std::time::Duration::from_millis(lifetime_ms.into()));
    }
    if idle < size {
        let owner = owner.clone();
        // A released connection is closed when the pool already keeps `idle`
        // idle connections.
        options = options.after_release(move |_, _| {
            let keep = owner.get().and_then(std::sync::Weak::upgrade).is_none_or(|db| db.pool.num_idle() < idle as usize);
            Box::pin(async move { Ok(keep) })
        });
    }
    options
}

#[cfg(test)]
#[path = "db/sqlite_version_tests.rs"]
mod sqlite_version_tests;

#[cfg(test)]
#[path = "db/sqlite_row_lock_restore_tests.rs"]
mod sqlite_row_lock_restore_tests;

#[cfg(test)]
#[path = "db/executor_route_tests.rs"]
mod executor_route_tests;

#[cfg(test)]
#[path = "db/pool_stats_tests.rs"]
mod pool_stats_tests;

#[cfg(test)]
#[path = "../tests/unit/time_precision.rs"]
mod time_precision_tests;

fn parse_sqlite_version(version: &str) -> Result<(u32, u32, u32)> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() != 3 && parts.len() != 4 {
        return Err(Error::internal(format!("SQLite library version {version:?} must have three or four decimal components")));
    }
    let mut numbers = Vec::with_capacity(parts.len());
    for part in parts {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(Error::internal(format!("SQLite library version {version:?} has invalid component {part:?}")));
        }
        numbers.push(
            part.parse::<u32>().map_err(|error| Error::internal(format!("SQLite library version {version:?} has component {part:?} outside u32: {error}")))?,
        );
    }
    Ok((numbers[0], numbers[1], numbers[2]))
}

fn check_sqlite_version(version: &str) -> Result<()> {
    let parsed = parse_sqlite_version(version)?;
    if parsed < (3, 46, 0) {
        return Err(Error::Engine { code: codes::CAPABILITY_UNSUPPORTED.into(), msg: format!("SQLite {version} is older than 3.46"), source: None });
    }
    Ok(())
}

trait SqliteRowLockSequenceOps {
    async fn set_nowait(&mut self) -> Result<()>;
    async fn take_row_lock(&mut self) -> Result<()>;
    async fn restore_timeout(&mut self) -> Result<()>;
}

async fn run_sqlite_row_lock_sequence(ops: &mut impl SqliteRowLockSequenceOps) -> Result<()> {
    let primary = match ops.set_nowait().await {
        Ok(()) => ops.take_row_lock().await,
        Err(error) => Err(error),
    };
    let restore = ops.restore_timeout().await;
    match (primary, restore) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(primary), Ok(())) => Err(primary),
        (Ok(()), Err(restore)) => Err(restore),
        (Err(primary), Err(restore)) => Err(Error::Cleanup { primary: Box::new(primary), cleanup: vec![restore] }),
    }
}

struct SqliteRowLockSequence<'a> {
    db: &'a Db,
    /// The transaction of a SQLite or a markdown connection.
    tx: &'a mut TxInner,
    transaction: Option<u64>,
    previous: i64,
    nowait: bool,
}

impl SqliteRowLockSequenceOps for SqliteRowLockSequence<'_> {
    async fn set_nowait(&mut self) -> Result<()> {
        let sql = "PRAGMA busy_timeout=0";
        let start = std::time::Instant::now();
        let result = crate::tx::raw_on(self.db, self.tx, Sent::bare(KIND_UTILITY, &[], self.transaction, sql)).await;
        self.db.statement_done(Sent::bare(KIND_UTILITY, &[], self.transaction, sql), start, result)
    }

    async fn take_row_lock(&mut self) -> Result<()> {
        let tables = [crate::tx::ROW_LOCK_TABLE.to_owned()];
        let insert = "INSERT INTO \"orm__row_lock\" (\"id\") VALUES (1) ON CONFLICT (\"id\") DO UPDATE SET \"id\"=excluded.\"id\"";
        let start = std::time::Instant::now();
        let sent = match &mut *self.tx {
            TxInner::Sqlite(t) => sqlx::raw_sql(sqlx::SqlSafeStr::into_sql_str(sqlx::AssertSqlSafe(insert))).execute(&mut **t).await.map(drop),
            TxInner::Markdown(lease) => lease.raw(insert).await,
            _ => return Err(Error::internal("a SQLite row lock on another connection")),
        };
        let operation = match sent {
            Ok(()) => Ok(()),
            Err(error) => {
                let busy = crate::sqlite_busy(&error);
                let mapped = Error::from(error);
                match busy {
                    Ok(true) if self.nowait => Err(Error::Engine { code: crate::codes::LOCK_NOT_AVAILABLE.into(), msg: mapped.to_string(), source: None }),
                    Ok(true) | Ok(false) => Err(mapped),
                    Err(error) => Err(error),
                }
            }
        };
        self.db.statement_done(Sent::bare(KIND_UTILITY, &tables, self.transaction, insert), start, operation)
    }

    async fn restore_timeout(&mut self) -> Result<()> {
        let sql = format!("PRAGMA busy_timeout={}", self.previous);
        crate::tx::raw_on(self.db, self.tx, Sent::bare(KIND_UTILITY, &[], self.transaction, &sql)).await
    }
}

impl Db {
    /// Connects to the database selected by the DSN URI and registers the set
    /// of a generated schema on the connection, as `utils().schema().register`
    /// does; the connect helper of generated models calls it. A manifest text
    /// that does not hash to its declared hash fails with CONFIG before the
    /// connection opens. Registering reads nothing from the database: `install`
    /// and `add_tables_and_columns` verify the database.
    pub async fn connect_schema(dsn: &str, schema: &Schema, pool_size: u32, cfg: Config) -> Result<Db> {
        schema.registered()?;
        let db = Db::connect(dsn, pool_size, cfg).await?;
        if let Err(error) = db.register(schema) {
            db.close().await;
            return Err(error);
        }
        Ok(db)
    }

    /// Registers a set of the schema on this connection. Registering the same set again changes nothing.
    pub(crate) fn register(&self, schema: &Schema) -> Result<()> {
        schema.registered()?;
        if self.inner.sets.write().unwrap().insert(schema.hash().to_owned()) {
            self.inner.schemas.write().unwrap().push(schema.interned());
        }
        Ok(())
    }

    /// Connects to the database selected by the DSN URI with at most
    /// `pool_size` open connections; zero uses 10. The connection has no set
    /// registered: a model request on it fails with SCHEMA_HASH_MISMATCH until
    /// `install` registers the set of the model.
    pub async fn connect(dsn: &str, pool_size: u32, mut cfg: Config) -> Result<Db> {
        if cfg.plan_cache_size == 0 || cfg.statement_cache_size == 0 {
            return Err(Error::Config("cache sizes must be positive".into()));
        }
        if cfg.aes_version <= 0 {
            return Err(Error::Config("aes current version is not declared".into()));
        }
        for (version, key) in &cfg.aes_keys {
            if *version <= 0 || key.is_empty() {
                return Err(Error::Config("aes key list holds an invalid version or an empty key".into()));
            }
        }
        if cfg.aes_keys.is_empty() {
            if !cfg.aes_key.is_empty() {
                cfg.aes_keys.insert(cfg.aes_version, cfg.aes_key.clone());
            }
        } else {
            let current = cfg.aes_keys.get(&cfg.aes_version).ok_or_else(|| Error::Config("aes current version is not declared".into()))?;
            if cfg.aes_key.is_empty() {
                cfg.aes_key = current.clone();
            } else if &cfg.aes_key != current {
                return Err(Error::Config("aes key differs from the key list at the current version".into()));
            }
        }
        let pool_size = if pool_size == 0 { DEFAULT_POOL_SIZE } else { pool_size };
        if cfg.pool_idle_size > pool_size {
            return Err(Error::Config(format!("pool idle size must be between 0 and the pool size {pool_size}")));
        }
        let idle = if cfg.pool_idle_size == 0 { pool_size } else { cfg.pool_idle_size };
        let owner = PoolOwner::default();
        let parsed = parse_dsn(dsn)?;
        let dialect = Dialect::parse(parsed.sql_driver());
        let cache = cfg.statement_cache_size;
        let timeout = cfg.statement_timeout_ms;
        // The server of a mysql pool, which its first connection reads (DIA-201).
        let read = Arc::new(tokio::sync::OnceCell::<crate::MySqlServer>::new());
        let pool_read = Arc::clone(&read);
        // A LISTEN subscription opens a connection of its own with the options of the pool (DIA-194).
        let listen = match &parsed.options {
            ConnectOptions::Postgres(o) => Some(o.clone()),
            _ => None,
        };
        let pool = match parsed.options {
            ConnectOptions::Markdown(dsn) => Pool::Markdown(open_markdown(dsn, pool_size, idle, &cfg).await?),
            // A mysql connection reads the server of its pool before any other statement (DIA-201): the first connection of the
            // pool reads it by VERSION(), and every later one, reconnects included, takes the value that it read. MySQL bounds
            // SELECT statements with max_execution_time and MariaDB every statement with max_statement_time, so the statement
            // timeout is set by the server (DIA-208) before the connection runs a statement of the caller.
            ConnectOptions::MySql(o) => Pool::MySql(
                pool_options::<sqlx::MySql>(pool_size, idle, cfg.pool_lifetime_ms, &owner)
                    .after_connect(move |conn, _| {
                        let read = Arc::clone(&pool_read);
                        Box::pin(async move {
                            let server = *read
                                .get_or_try_init(|| async {
                                    let version: String = sqlx::query_scalar("SELECT VERSION()").fetch_one(&mut *conn).await?;
                                    Ok::<_, sqlx::Error>(crate::MySqlServer::of_version(&version))
                                })
                                .await?;
                            // sqlx adds PIPES_AS_CONCAT and NO_ENGINE_SUBSTITUTION to the
                            // server's sql_mode, and the IGNORE_SPACE client flag adds that
                            // mode; this replaces them with the declared one.
                            sqlx::query(sqlx::AssertSqlSafe(format!("SET SESSION sql_mode = '{MYSQL_SQL_MODE}'"))).execute(&mut *conn).await?;
                            if timeout > 0 {
                                sqlx::query(sqlx::AssertSqlSafe(server.statement_timeout(timeout))).execute(&mut *conn).await?;
                            }
                            Ok(())
                        })
                    })
                    .connect_with(o.statement_cache_capacity(cache))
                    .await?,
            ),
            // PostgreSQL bounds every statement with statement_timeout, sent
            // as a startup parameter: it belongs to the client session, so a
            // pooler in transaction mode sets it on every server connection it
            // assigns to this connection and on no other.
            ConnectOptions::Postgres(o) => {
                let o = if timeout > 0 { o.options([("statement_timeout", timeout.to_string())]) } else { o };
                Pool::Postgres(
                    pool_options::<sqlx::Postgres>(pool_size, idle, cfg.pool_lifetime_ms, &owner).connect_with(o.statement_cache_capacity(cache)).await?,
                )
            }
            // SQLite has no session timeout: its bound is the busy_timeout of the DSN (CFG-6), which the
            // statement timeout leaves as it is.
            ConnectOptions::Sqlite(o) => {
                // The version of the SQLite library bundled by sqlx. No statement asking for it is sent.
                let raw_version = libsqlite3_sys::SQLITE_VERSION;
                let version = raw_version
                    .to_str()
                    .map_err(|error| Error::internal(format!("SQLite library version bytes {:?} are not UTF-8: {error}", raw_version.to_bytes())))?;
                check_sqlite_version(version)?;
                let pool = pool_options::<sqlx::Sqlite>(pool_size, idle, cfg.pool_lifetime_ms, &owner).connect_with(o.statement_cache_capacity(cache)).await?;
                Pool::Sqlite(pool)
            }
        };
        // The server is read once by VERSION(), never by the handshake, whose version a pooler may state for itself (DIA-201).
        let server = match &pool {
            Pool::MySql(p) => {
                // The first connection of the pool reads the server as it opens. The connection returns to the pool before
                // open ends, as a completed statement does (INT-79): the drop handler of SQLx returns it from a task of its
                // own, and the pool statistics after open count it idle.
                let mut connection = p.acquire().await?;
                connection.return_to_pool().await;
                *read.get().ok_or_else(|| Error::internal("a mysql connection opened without reading its server"))?
            }
            _ => crate::MySqlServer::MySql,
        };
        let db = Db {
            inner: Arc::new(DbInner {
                id: NEXT_DB.fetch_add(1, Ordering::Relaxed),
                pool,
                listen,
                dialect,
                server,
                cfg,
                zone: parsed.zone,
                plans: Mutex::new(HashMap::new()),
                plan_order: Mutex::new(VecDeque::new()),
                sets: std::sync::RwLock::new(std::collections::HashSet::new()),
                schemas: std::sync::RwLock::new(Vec::new()),
                closed: AtomicBool::new(false),
                idle_trim: tokio::sync::Mutex::new(()),
                sqlite_lock_ready: AtomicBool::new(false),
                subscribers: Subscribers::default(),
                rollback_fault: AtomicBool::new(false),
                #[cfg(feature = "test-faults")]
                statement_fault: Mutex::new(None),
                #[cfg(feature = "test-faults")]
                statement_gate: Mutex::new(None),
                #[cfg(feature = "test-faults")]
                fixed_clock: Mutex::new(None),
                #[cfg(feature = "test-faults")]
                last_affected: Mutex::new(None),
            }),
            hook: None,
        };
        if owner.set(Arc::downgrade(&db.inner)).is_err() {
            return Err(Error::internal("the owner of a new database was already set"));
        }
        Ok(db)
    }

    pub(crate) fn id(&self) -> u64 {
        self.inner.id
    }

    /// Returns a handle on the same connection whose hook receives each request
    /// of the handle right before the client plans it (docs/operations/usage.md "Request
    /// hook"). The handle shares the pool, the caches, the subscribers and the
    /// active transactions of the connection; it carries one hook, so this
    /// replaces the hook of a hooked handle.
    pub fn with_request_hook(&self, hook: impl Fn(&mut crate::ir::Request, &mut RequestParams) -> Result<()> + Send + Sync + 'static) -> Db {
        Db { inner: self.inner.clone(), hook: Some(Arc::new(hook)) }
    }

    /// The database of the connection: mysql, postgres, sqlite, or markdown, a
    /// corpus that a flowmark server serves.
    pub fn driver(&self) -> &'static str {
        match &self.inner.pool {
            Pool::MySql(_) => "mysql",
            Pool::Postgres(_) => "postgres",
            Pool::Sqlite(_) => "sqlite",
            Pool::Markdown(_) => "markdown",
        }
    }

    /// The database whose SQL the connection runs: sqlite on a markdown connection, whose server runs SQL in SQLite's
    /// dialect (DIA-185), and otherwise the driver.
    pub fn sql_driver(&self) -> &'static str {
        match &self.inner.pool {
            Pool::Markdown(_) => "sqlite",
            _ => self.driver(),
        }
    }

    /// The server of the connection that dbspec introspects by (DIA-203): the server that connect read on a mysql
    /// connection (DIA-201), and the database's own on PostgreSQL and SQLite; a markdown connection answers in SQLite's
    /// dialect, as its server (DIA-185).
    pub(crate) fn dbspec_server(&self) -> crate::dbspec::Server {
        match (&self.inner.pool, self.inner.server) {
            (Pool::MySql(_), crate::MySqlServer::MariaDb) => crate::dbspec::Server::MariaDb,
            (Pool::MySql(_), crate::MySqlServer::MySql) => crate::dbspec::Server::MySql,
            (Pool::Postgres(_), _) => crate::dbspec::Server::Postgres,
            (Pool::Sqlite(_) | Pool::Markdown(_), _) => crate::dbspec::Server::Sqlite,
        }
    }

    /// The pool of the connection.
    pub fn pool(&self) -> &Pool {
        &self.inner.pool
    }

    /// The connection pool state.
    pub fn stats(&self) -> DbStats {
        let (max, size, idle) = match &self.inner.pool {
            Pool::MySql(p) => (p.options().get_max_connections(), p.size(), p.num_idle()),
            Pool::Postgres(p) => (p.options().get_max_connections(), p.size(), p.num_idle()),
            Pool::Sqlite(p) => (p.options().get_max_connections(), p.size(), p.num_idle()),
            Pool::Markdown(p) => return p.stats(),
        };
        let idle = idle as u32;
        DbStats { max_open_connections: max, open_connections: size, in_use: pool_in_use(size, idle), idle }
    }

    /// Keeps the idle size after a connection returned (CFG-5). The check of after_release runs before the connection is idle,
    /// so connections that return together all pass it; each end of work closes what that left beyond the size.
    pub(crate) async fn keep_idle_size(&self) {
        let idle = self.inner.cfg.pool_idle_size as usize;
        if idle == 0 {
            return;
        }
        let _closing = self.inner.idle_trim.lock().await;
        match &self.inner.pool {
            Pool::MySql(pool) => close_idle_beyond(pool, idle).await,
            Pool::Postgres(pool) => close_idle_beyond(pool, idle).await,
            Pool::Sqlite(pool) => close_idle_beyond(pool, idle).await,
            Pool::Markdown(_) => {}
        }
    }

    /// Closes the pool and clears cached plans. Calling it more than once is safe.
    pub async fn close(&self) {
        self.inner.closed.store(true, Ordering::Release);
        self.inner.plans.lock().unwrap().clear();
        self.inner.plan_order.lock().unwrap().clear();
        self.inner.pool.close().await;
    }

    /// Plans (or fetches from cache) the statements of the request's shape.
    pub(crate) async fn plan(&self, req: &mut Req) -> Result<Arc<Plan>> {
        self.plan_with_parameter_count(req, None).await
    }

    /// Plans a split probe or part while retaining parameter indices from the parent request.
    pub(crate) async fn plan_split_part(&self, req: &mut Req, n_params: usize) -> Result<Arc<Plan>> {
        self.plan_with_parameter_count(req, Some(n_params)).await
    }

    async fn plan_with_parameter_count(&self, req: &mut Req, n_params: Option<usize>) -> Result<Arc<Plan>> {
        if let Some(e) = req.error() {
            return Err(e);
        }
        // The plan cache is keyed by manifest_hash, so a model that declares the same hash but has different text
        // is checked against that text before the cache is consulted, so generated code never uses another model's plan.
        let manifest = req.schema.manifest()?;
        // A connection plans only the sets registered to it. The targets a request may run against are
        // decided by the database the connection uses, not by the code the process has read.
        if !self.inner.sets.read().unwrap().contains(req.schema.hash()) {
            return Err(Error::Engine {
                code: codes::SCHEMA_HASH_MISMATCH.into(),
                msg: format!("manifest {} is not registered on this connection: connect through its generated models or install it", req.schema.hash()),
                source: None,
            });
        }
        let Some(dialect) = self.inner.dialect else { return Err(Error::internal("the connection has no dialect")) };
        if let Some(n_params) = n_params {
            req.ir.n_params = n_params;
        }
        // A split probe or part keeps the parameter indices of its parent request (n_params), so only a root plan is renumbered.
        if n_params.is_none() {
            req.canonicalize()?;
        }
        engine::validate(&manifest, &req.ir)?;
        crate::request::validate_page_params(&req.ir, &req.params)?;
        let key = match n_params {
            Some(n_params) => req.shape_key_with_n_params(n_params),
            None => req.shape_key(),
        };
        if let Some(p) = self.inner.plans.lock().unwrap().get(&key) {
            return Ok(p.clone());
        }
        let mut plan = engine::compile_for(&manifest, dialect, self.inner.server, &req.ir)?;
        for st in &mut plan.steps {
            st.plan_id = key;
        }
        let plan = Arc::new(plan);
        let mut plans = self.inner.plans.lock().unwrap();
        if let Some(prev) = plans.get(&key) {
            return Ok(prev.clone());
        }
        plans.insert(key, plan.clone());
        let mut order = self.inner.plan_order.lock().unwrap();
        order.push_back(key);
        while order.len() > self.inner.cfg.plan_cache_size {
            if let Some(oldest) = order.pop_front() {
                plans.remove(&oldest);
            }
        }
        Ok(plan)
    }

    #[cfg(test)]
    pub(crate) fn max_cached_bind_slots(&self) -> usize {
        self.inner.plans.lock().unwrap().values().map(|plan| plan.steps[0].bind_slots.len()).max().unwrap_or(0)
    }

    /// The executor clock in the connection time zone (UTC), with six fraction digits.
    pub(crate) fn now_text(&self) -> String {
        #[cfg(feature = "test-faults")]
        if let Some(clock) = self.inner.fixed_clock.lock().unwrap().clone() {
            return clock;
        }
        self.inner.zone.now().format(SQLITE_DATETIME).to_string()
    }

    /// Writes a datetime or date value in the text form SQLite stores, so a
    /// string value compares equal to the stored value; every driver binds that
    /// text (docs/spec/dialects.md). A datetime string with
    /// an offset is converted to the connection time zone. The `datetime(p)` text
    /// is written with p fractional digits; if a nonzero digit follows the p digits, it is CODEC_ENCODE.
    fn bind_time_value(&self, v: Param, col_type: &str, precision: i64) -> Result<Param> {
        bound_time_value(v, col_type, precision, &self.inner.zone)
    }

    /// Sets the bind slot values of the step. `audit` is the audit record of the transaction in which the step runs.
    pub(crate) fn args(&self, st: &Step, params: &[Param], parent_vals: &[Param], audit: Option<&AuditKey>) -> Result<Vec<Param>> {
        let cfg = &self.inner.cfg;
        let sqlite = self.sql_driver() == "sqlite";
        let mut out = Vec::with_capacity(st.bind_slots.len() + parent_vals.len());
        let mut clock: Option<String> = None;
        for b in &st.bind_slots {
            match b.from.as_str() {
                "parent" => out.extend(parent_vals.iter().cloned()),
                "param" => {
                    // A transformed value is the text of its operator, and a host-styled value is the input of its
                    // first stage, which host_encode checks. A statement of utils().run binds its parameters as the
                    // database takes them, so its errors are the database's own (INT-150).
                    let utils = st.role == "utils";
                    if let (false, Some(v)) = (utils, params.get(b.param)) {
                        crate::bind_check::check_assign(b.param, v, &crate::bind_check::bind_slot_type(b))?;
                    }
                    if !utils && b.transform.is_empty() && b.host_styles.is_empty() {
                        if let Some(v) = params.get(b.param) {
                            crate::bind_check::check_param(b.param, v, &crate::bind_check::bind_slot_type(b), &self.inner.zone)?;
                        }
                    }
                    let mut v = param_arg(b, params)?;
                    if b.col_type == "datetime" || b.col_type == "date" {
                        v = self.bind_time_value(v, &b.col_type, b.precision)?;
                    }
                    if b.col_type == "time" {
                        v = time_value(v, b.precision)?;
                    }
                    if b.col_type == "decimal" {
                        let precision = u8::try_from(b.precision).map_err(|error| Error::Engine {
                            code: codes::SCHEMA_INVALID.into(),
                            msg: format!("invalid decimal precision {}: {error}", b.precision),
                            source: None,
                        })?;
                        let scale = u8::try_from(b.scale).map_err(|error| Error::Engine {
                            code: codes::SCHEMA_INVALID.into(),
                            msg: format!("invalid decimal scale {}: {error}", b.scale),
                            source: None,
                        })?;
                        v = match v {
                            Param::Null => Param::Null,
                            Param::Str(text) if sqlite => Param::I64(crate::decimal::scaled(&text, precision, scale)?),
                            Param::Str(text) => Param::Str(crate::decimal::normalize(&text, precision, scale)?),
                            other => {
                                return Err(Error::Engine {
                                    code: codes::CODEC_ENCODE.into(),
                                    msg: format!("decimal bind requires exact text, received {other:?}"),
                                    source: None,
                                })
                            }
                        };
                    }
                    out.push(if b.host_styles.is_empty() {
                        v
                    } else if b.host_styles.iter().any(|s| s == "blind_index") {
                        if matches!(v, Param::Null) {
                            Param::Null
                        } else {
                            Param::Str(crate::codec::blind_index(&v, &cfg.blind_index_key)?)
                        }
                    } else {
                        crate::codec::host_encode(&v, &b.host_styles, &cfg.aes_key)?
                    });
                }
                "config" => match b.name.as_str() {
                    "aes_version" => out.push(Param::I64(cfg.aes_version as i64)),
                    _ => return Err(Error::Config(format!("config value {} is not configured", b.name))),
                },
                "now" => {
                    // One statement reads the clock once, so its clock columns are equal.
                    let text = clock.get_or_insert_with(|| self.now_text()).clone();
                    out.push(Param::Str(clock_digits(&text, b.precision)?));
                }
                // The audit slot is the primary key of the audit record the transaction inserted. If there is no audit, or the audit table
                // records audit for another entity, it is CONFIG.
                "audit" => out.push(match audit {
                    Some(a) if a.table == b.name => a.key.clone(),
                    Some(a) => {
                        return Err(Error::Config(format!(
                            "the audited table records its audits in {}, but the audit of the transaction is a row of {}",
                            b.name, a.table
                        )))
                    }
                    None => return Err(Error::Config("a write of an audited table needs an audit: run it in a transaction with audit values".into())),
                }),
                other => return Err(Error::internal(format!("bind from {other}"))),
            }
        }
        if sqlite {
            for v in &mut out {
                if let Param::DateTime(t) = v {
                    *v = Param::Str(t.format(SQLITE_DATETIME).to_string());
                }
            }
        }
        Ok(out)
    }

    /// The bind as shown in the statement event: the values with the `now` slots masked.
    fn shown<'a>(&self, st: &Step, args: &'a [Param], n_parent: usize) -> std::borrow::Cow<'a, [Param]> {
        if st.bind_slots.iter().any(|b| b.from == "now") {
            std::borrow::Cow::Owned(masked(st, args, n_parent))
        } else {
            std::borrow::Cow::Borrowed(args)
        }
    }

    /// Publishes the statement event of the step and returns the result the operation receives. `shown` is the event's
    /// bind, built only when there is a subscriber.
    fn step_done<'a, T>(
        &self,
        st: &Step,
        origin: Origin<'_>,
        sql: &str,
        shown: impl FnOnce() -> std::borrow::Cow<'a, [Param]>,
        start: std::time::Instant,
        r: Result<T>,
    ) -> Result<T> {
        if !self.inner.subscribers.observed() {
            // A mysql error number is read by the table of the connection's server (DIA-201), observed or not.
            return r.map_err(|e| e.for_server(self.inner.server, &st.lock));
        }
        let binds = shown();
        let tables = origin.tables.unwrap_or(&st.tables);
        self.statement_done(
            Sent { sql, binds: &binds, kind: origin.kind.unwrap_or_else(|| statement_kind(&st.sql)), tables, transaction: origin.transaction, lock: &st.lock },
            start,
            r,
        )
    }

    /// Takes SQLite's row lock on the transaction connection. SQLite has no row lock clause, so
    /// one lock row bound to the transaction stands in for each ORM lock request in turn. A write statement
    /// waits for the lock up to the connection's busy_timeout, and a NOWAIT request sets the wait to 0.
    async fn sqlite_row_lock(&self, target: &mut Target<'_>, transaction: Option<u64>, mode: &str) -> Result<()> {
        if mode.is_empty() {
            return Ok(());
        }
        let tx = match target {
            Target::Tx(tx) if matches!(**tx, TxInner::Sqlite(_) | TxInner::Markdown(_)) => &mut **tx,
            Target::Pool(Pool::Sqlite(_) | Pool::Markdown(_)) => return Err(Error::Config("SQLite row locks require an ORM transaction".into())),
            _ => return Ok(()),
        };
        let nowait = mode.ends_with("_nowait");
        if nowait {
            let read = "PRAGMA busy_timeout";
            let start = std::time::Instant::now();
            let r = match tx {
                TxInner::Sqlite(t) => sqlx::query_scalar::<_, i64>(read).fetch_one(&mut **t).await.map_err(Error::from),
                TxInner::Markdown(lease) => match lease.statement(read, &[]).await {
                    Ok(result) => match result.rows.first().and_then(|row| row.first()) {
                        Some(crate::markdown::MarkdownCell::Integer(n)) => Ok(*n),
                        other => Err(Error::internal(format!("PRAGMA busy_timeout answered {other:?}"))),
                    },
                    Err(error) => Err(Error::from(error)),
                },
                _ => Err(Error::internal("a SQLite row lock on another connection")),
            };
            let previous = self.statement_done(Sent::bare(KIND_UTILITY, &[], transaction, read), start, r)?;
            let mut sequence = SqliteRowLockSequence { db: self, tx, transaction, previous, nowait: true };
            return run_sqlite_row_lock_sequence(&mut sequence).await;
        }
        let mut sequence = SqliteRowLockSequence { db: self, tx, transaction, previous: 0, nowait: false };
        sequence.take_row_lock().await
    }

    pub(crate) async fn run_query(
        &self,
        target: Target<'_>,
        origin: Origin<'_>,
        st: &Step,
        params: &[Param],
        parent_vals: Vec<Param>,
        audit: Option<&AuditKey>,
    ) -> Result<Vec<DriverRow>> {
        let (sql, parent_vals) = statement(st, parent_vals, matches!(self.inner.pool, Pool::Postgres(_)))?;
        let args = self.args(st, params, &parent_vals, audit)?;
        // A configured statement fault ends this statement without sending it.
        #[cfg(feature = "test-faults")]
        if let Some(error) = crate::testing::take_statement_fault(self) {
            return self.step_done(st, origin, &sql, || self.shown(st, &args, parent_vals.len()), std::time::Instant::now(), Err(error));
        }
        // A held transaction statement waits here, while it holds the transaction connection, until the test releases it.
        #[cfg(feature = "test-faults")]
        if matches!(target, Target::Tx(_)) {
            crate::testing::wait_at_statement_gate(self).await;
        }
        let start = std::time::Instant::now();
        let pooled = matches!(target, Target::Pool(_));
        let r: Result<Vec<DriverRow>> = match target {
            Target::Pool(Pool::MySql(p)) => fetch_mysql_pool(&sql, &args, p).await.map(|v| v.into_iter().map(DriverRow::MySql).collect()).map_err(Error::from),
            Target::Tx(TxInner::MySql(t)) => fetch_mysql(&sql, &args, &mut **t.conn.as_mut().expect("active MySQL transaction connection"))
                .await
                .map(|v| v.into_iter().map(DriverRow::MySql).collect())
                .map_err(Error::from),
            Target::Pool(Pool::Postgres(p)) => {
                fetch_pg_pool(&sql, &args, &arg_types(st, parent_vals.len()), p).await.map(|v| v.into_iter().map(DriverRow::Postgres).collect())
            }
            Target::Tx(TxInner::Postgres(t)) => {
                fetch_pg(&sql, &args, &arg_types(st, parent_vals.len()), &mut **t).await.map(|v| v.into_iter().map(DriverRow::Postgres).collect())
            }
            Target::Pool(Pool::Sqlite(p)) => {
                fetch_sqlite_pool(&sql, &args, p).await.map(|v| v.into_iter().map(DriverRow::Sqlite).collect()).map_err(Error::from)
            }
            Target::Tx(TxInner::Sqlite(t)) => {
                fetch_sqlite(&sql, &args, &mut **t).await.map(|v| v.into_iter().map(DriverRow::Sqlite).collect()).map_err(Error::from)
            }
            Target::Pool(Pool::Markdown(p)) => {
                p.bound(&sql, &args).await.map(|r| r.into_rows().into_iter().map(DriverRow::Markdown).collect()).map_err(Error::from)
            }
            Target::Tx(TxInner::Markdown(t)) => {
                t.bound(&sql, &args).await.map(|r| r.into_rows().into_iter().map(DriverRow::Markdown).collect()).map_err(Error::from)
            }
        };
        if pooled {
            self.keep_idle_size().await;
        }
        self.step_done(st, origin, &sql, || self.shown(st, &args, parent_vals.len()), start, r)
    }

    pub(crate) async fn run_execute(
        &self,
        target: Target<'_>,
        origin: Origin<'_>,
        st: &Step,
        params: &[Param],
        audit: Option<&AuditKey>,
    ) -> Result<(u64, u64)> {
        let args = self.args(st, params, &[], audit)?;
        let sql = st.sql.as_str();
        #[cfg(feature = "test-faults")]
        if let Some(error) = crate::testing::take_statement_fault(self) {
            return self.step_done(st, origin, sql, || self.shown(st, &args, 0), std::time::Instant::now(), Err(error));
        }
        let start = std::time::Instant::now();
        let pooled = matches!(target, Target::Pool(_));
        let r: Result<(u64, u64)> = match target {
            Target::Pool(Pool::MySql(p)) => exec_mysql_pool(sql, &args, p).await.map_err(Error::from),
            Target::Tx(TxInner::MySql(t)) => {
                exec_mysql(sql, &args, &mut **t.conn.as_mut().expect("active MySQL transaction connection")).await.map_err(Error::from)
            }
            Target::Pool(Pool::Postgres(p)) => exec_pg_pool(sql, &args, &arg_types(st, 0), p).await,
            Target::Tx(TxInner::Postgres(t)) => exec_pg(sql, &args, &arg_types(st, 0), &mut **t).await,
            Target::Pool(Pool::Sqlite(p)) => exec_sqlite_pool(sql, &args, p).await.map_err(Error::from),
            Target::Tx(TxInner::Sqlite(t)) => exec_sqlite(sql, &args, &mut **t).await.map_err(Error::from),
            Target::Pool(Pool::Markdown(p)) => p.bound(sql, &args).await.map(markdown_written).map_err(Error::from),
            Target::Tx(TxInner::Markdown(t)) => t.bound(sql, &args).await.map(markdown_written).map_err(Error::from),
        };
        if pooled {
            self.keep_idle_size().await;
        }
        self.step_done(st, origin, sql, || self.shown(st, &args, 0), start, r)
    }

    /// The statement of a request without executing it.
    pub(crate) async fn statement(&self, req: &mut Req) -> Result<Statement> {
        let plan = self.plan(req).await?;
        let st = &plan.steps[0];
        let audit = crate::tx::active_for(self).and_then(|t| t.audit());
        let args = self.args(st, &req.params, &[], audit.as_ref())?;
        let mut binds = Vec::with_capacity(args.len());
        for (b, a) in st.bind_slots.iter().zip(args) {
            binds.push(match b.from.as_str() {
                "now" => Param::Str(NOW_MASK.into()),
                _ => a,
            });
        }
        Ok(Statement { sql: st.sql.clone(), binds })
    }

    /// Runs one compiled statement `step`, a step of a plan of [`engine::compile`], with the
    /// request parameters `params`, on the connection or on its active transaction. Its bind slots
    /// are resolved as a model statement's are: host styles, decimals, SQLite time values, the AES
    /// key and key version, the clock and the audit of the transaction. A step that reads rows (it
    /// has an assemble) and a param slot past `params` fail with IR_INVALID before any statement
    /// runs (docs/operations/usage.md "Execute a compiled statement").
    pub async fn execute(&self, step: &Step, params: &[Param]) -> Result<()> {
        let ex = crate::tx::resolve(&Some(self.clone()))?;
        if matches!(ex, Executor::Db(_)) {
            self.ensure_open()?;
        }
        if step.assemble.is_some() {
            return Err(Error::Engine {
                code: codes::IR_INVALID.into(),
                msg: "execute runs a statement without rows; the statement is a read".into(),
                source: None,
            });
        }
        for (i, b) in step.bind_slots.iter().enumerate() {
            if b.from == "param" && b.param >= params.len() {
                return Err(Error::Engine {
                    code: codes::IR_INVALID.into(),
                    msg: format!("bind slot {i} reads parameter {}, but execute has {} parameters", b.param, params.len()),
                    source: None,
                });
            }
        }
        // The audit record precedes a write of an audited table; this entry point inserts it without a savepoint.
        if let Executor::Tx(t) = &ex {
            if crate::model::binds_audit(step) {
                t.audit_for(false).await?;
            }
        }
        // This is the same path as model writes: it runs on the connection or the active transaction, and uses the transaction's audit,
        // statement fault, statement event, and driver error conversion as they are.
        ex.execute(step, params).await.map(drop)
    }

    pub(crate) fn ensure_open(&self) -> Result<()> {
        if self.inner.closed.load(Ordering::Acquire) {
            return Err(Error::Config("database is closed".into()));
        }
        Ok(())
    }
}

/// The text and binds of a statement that was not executed.
#[derive(Debug, Clone, PartialEq)]
pub struct Statement {
    pub sql: String,
    pub binds: Vec<Param>,
}

/// One statement of a plan: `role` is main, count or relation, `tables` are the tables that it reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryPlanStep {
    pub role: String,
    pub tables: Vec<String>,
    pub sql: String,
}

/// Where the step ran and the source of the event: kind, table (the step's table if none), and transaction number.
#[derive(Clone, Copy)]
pub(crate) struct Origin<'a> {
    kind: Option<&'a str>,
    tables: Option<&'a [String]>,
    transaction: Option<u64>,
}

/// Where a statement runs: a connection or an active transaction.
#[derive(Clone)]
pub(crate) enum Executor {
    Db(Db),
    Tx(Arc<TxShared>),
}

macro_rules! with_executor_target {
    ($executor:expr, $db:ident, $target:ident, $audit:ident, $validate:block, $run:block) => {{
        match $executor {
            Executor::Db($db) => {
                $validate
                let $target = Target::Pool(&$db.inner.pool);
                let $audit: Option<AuditKey> = None;
                $run
            }
            Executor::Tx(tx) => {
                let mut guard = tx.enter()?;
                let inner = guard.as_mut().ok_or_else(|| Error::Config("transaction already finished".into()))?;
                let $db = &tx.db;
                let $target = Target::Tx(inner);
                let $audit = tx.audit();
                $run
            }
        }
    }};
}

impl Executor {
    pub(crate) fn db(&self) -> &Db {
        match self {
            Executor::Db(d) => d,
            Executor::Tx(t) => &t.db,
        }
    }

    /// The number of the transaction the statement runs in. None if outside a transaction.
    pub(crate) fn transaction(&self) -> Option<u64> {
        match self {
            Executor::Db(_) => None,
            Executor::Tx(t) => Some(t.number),
        }
    }

    /// Runs a step of the model plan and returns the row. The event's kind and table are the step's.
    pub(crate) async fn query(&self, st: &Step, params: &[Param], parent_vals: Vec<Param>) -> Result<Vec<DriverRow>> {
        self.query_as(None, None, st, params, parent_vals).await
    }

    /// Runs the step and returns the row. If `kind` and `tables` are given, the event carries them.
    pub(crate) async fn query_as(
        &self,
        kind: Option<&str>,
        tables: Option<&[String]>,
        st: &Step,
        params: &[Param],
        parent_vals: Vec<Param>,
    ) -> Result<Vec<DriverRow>> {
        let origin = Origin { kind, tables, transaction: self.transaction() };
        with_executor_target!(
            self,
            db,
            target,
            audit,
            {
                db.ensure_open()?;
            },
            { db.run_query(target, origin, st, params, parent_vals, audit.as_ref()).await }
        )
    }

    /// Takes SQLite's row lock in the transaction. On other databases, nothing is sent.
    pub(crate) async fn sqlite_row_lock(&self, mode: &str) -> Result<()> {
        match self {
            Executor::Db(d) => d.sqlite_row_lock(&mut Target::Pool(&d.inner.pool), None, mode).await,
            Executor::Tx(t) => {
                let mut guard = t.enter()?;
                let inner = guard.as_mut().ok_or_else(|| Error::Config("transaction already finished".into()))?;
                t.db.sqlite_row_lock(&mut Target::Tx(inner), Some(t.number), mode).await
            }
        }
    }

    /// Runs a step of the model plan and returns (last id, number of changed rows).
    pub(crate) async fn execute(&self, st: &Step, params: &[Param]) -> Result<(u64, u64)> {
        self.execute_as(None, None, st, params).await
    }

    /// Runs the step. If `kind` and `tables` are given, the event carries them.
    pub(crate) async fn execute_as(&self, kind: Option<&str>, tables: Option<&[String]>, st: &Step, params: &[Param]) -> Result<(u64, u64)> {
        let origin = Origin { kind, tables, transaction: self.transaction() };
        with_executor_target!(self, db, target, audit, { db.ensure_open()? }, { db.run_execute(target, origin, st, params, audit.as_ref()).await })
    }
}

/// The (last insert id, changed rows) of a markdown statement, SQLite's `last_insert_rowid()` and `changes()` (PRT-70).
fn markdown_written(result: crate::markdown::MarkdownResult) -> (u64, u64) {
    (result.last_insert_id as u64, result.affected)
}

fn digits(b: &[u8]) -> bool {
    b.iter().all(u8::is_ascii_digit)
}

/// A date or datetime bind in the text form SQLite stores (Db::bind_time_value) in the connection time zone `zone`.
pub(crate) fn bound_time_value(v: Param, col_type: &str, precision: i64, zone: &Zone) -> Result<Param> {
    if col_type == "datetime" {
        precision_count(precision)?;
    }
    match v {
        Param::DateTime(t) if col_type == "date" => Ok(Param::Str(t.format("%Y-%m-%d").to_string())),
        Param::Str(text) if col_type == "date" => {
            if sqlite_date_text(&text) {
                Ok(Param::Str(text))
            } else {
                Err(invalid_time_text(col_type))
            }
        }
        Param::DateTime(t) => datetime_digits(&t.format(SQLITE_DATETIME).to_string(), precision).map(Param::Str),
        Param::Str(text) => {
            let full = sqlite_datetime_text(&text, zone)?.ok_or_else(|| invalid_time_text(col_type))?;
            datetime_digits(&full, precision).map(Param::Str)
        }
        other => Ok(other),
    }
}

fn sqlite_date_text(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && digits(&b[0..4])
        && b[4] == b'-'
        && digits(&b[5..7])
        && b[7] == b'-'
        && digits(&b[8..10])
        && chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").is_ok()
}

/// `YYYY-MM-DD[ T]HH:MM:SS[.f{1,6}][Z|±HH:MM]` as stored SQLite text in the
/// connection time zone, or None when the text has another form.
fn sqlite_datetime_text(text: &str, zone: &Zone) -> Result<Option<String>> {
    let (body, offset) = if let Some(body) = text.strip_suffix('Z') {
        (body, Some(0))
    } else {
        let b = text.as_bytes();
        let n = b.len();
        if n >= 6 && (b[n - 6] == b'+' || b[n - 6] == b'-') && b[n - 3] == b':' && digits(&b[n - 5..n - 3]) && digits(&b[n - 2..]) {
            // Both fields passed `digits` above, so each is two ASCII digits and the sum is read without a parse that could fail.
            let field = |range: std::ops::Range<usize>| b[range].iter().fold(0, |value, d| value * 10 + i32::from(d - b'0'));
            let minutes = (field(n - 5..n - 3) * 60 + field(n - 2..n)) * if b[n - 6] == b'-' { -1 } else { 1 };
            (&text[..n - 6], Some(minutes))
        } else {
            (text, None)
        }
    };
    let b = body.as_bytes();
    if b.len() < 19 || !sqlite_date_text(&body[..10]) || !(b[10] == b' ' || b[10] == b'T') {
        return Ok(None);
    }
    if !(digits(&b[11..13]) && b[13] == b':' && digits(&b[14..16]) && b[16] == b':' && digits(&b[17..19])) {
        return Ok(None);
    }
    let fraction = match &b[19..] {
        [] => "",
        [b'.', rest @ ..] if (1..=6).contains(&rest.len()) && digits(rest) => &body[20..],
        _ => return Ok(None),
    };
    let wall = format!("{} {}.{:0<6}", &body[..10], &body[11..19], fraction);
    let t = NaiveDateTime::parse_from_str(&wall, "%Y-%m-%d %H:%M:%S%.6f").map_err(|error| Error::internal(format!("{wall:?} is not a datetime: {error}")))?;
    match offset {
        None => Ok(Some(wall)),
        Some(minutes) => {
            let instant = t
                .checked_sub_signed(chrono::Duration::minutes(i64::from(minutes)))
                .ok_or_else(|| Error::internal(format!("{wall:?} with its offset is out of the datetime range")))?
                .and_utc();
            Ok(Some(format!("{}.{:0<6}", zone.local(instant).format("%Y-%m-%d %H:%M:%S"), fraction)))
        }
    }
}

/// The canonical date, time, and datetime text (docs/spec/protocol.md §5 "Parameters"): date is `YYYY-MM-DD`,
/// time is `HH:MM:SS.ffffff`, and datetime is `YYYY-MM-DD HH:MM:SS.ffffff` in the connection time zone; fractional digits the value lacks are 0.
/// Text in any other form is CODEC_ENCODE.
pub(crate) fn message_time_text(text: &str, col_type: &str, zone: &Zone) -> Result<String> {
    match col_type {
        "date" if sqlite_date_text(text) => Ok(text.to_owned()),
        "date" => Err(invalid_time_text(col_type)),
        "time" => {
            let b = text.as_bytes();
            let clock = b.len() >= 8
                && digits(&b[0..2])
                && b[2] == b':'
                && digits(&b[3..5])
                && b[5] == b':'
                && digits(&b[6..8])
                && &text[0..2] < "24"
                && &text[3..5] < "60"
                && &text[6..8] < "60";
            let fraction = match b.get(8..) {
                Some([]) => Some(""),
                Some([b'.', rest @ ..]) if (1..=6).contains(&rest.len()) && digits(rest) => Some(&text[9..]),
                _ => None,
            };
            match (clock, fraction) {
                (true, Some(f)) => Ok(format!("{}.{f:0<6}", &text[..8])),
                _ => Err(invalid_time_text("time")),
            }
        }
        _ => sqlite_datetime_text(text, zone)?.ok_or_else(|| invalid_time_text(col_type)),
    }
}

/// Shortens a six-fractional-digit `YYYY-MM-DD HH:MM:SS.ffffff` text to p fractional digits. If a nonzero digit
/// is in the dropped digits, the value changes, so it is CODEC_ENCODE.
fn datetime_digits(text: &str, precision: i64) -> Result<String> {
    let Some((whole, fraction, p)) = fractional_parts(text, precision)? else {
        return Ok(text.to_owned());
    };
    if fraction[p..].bytes().any(|b| b != b'0') {
        return Err(invalid_time_text("datetime"));
    }
    Ok(if p == 0 { whole.to_owned() } else { format!("{whole}.{}", &fraction[..p]) })
}

/// Truncates the six-digit fractional text of the executor clock to the p fractional digits of a `datetime(p)` column.
fn clock_digits(text: &str, precision: i64) -> Result<String> {
    let Some((whole, fraction, p)) = fractional_parts(text, precision)? else {
        return Ok(text.to_owned());
    };
    Ok(if p == 0 { whole.to_owned() } else { format!("{whole}.{}", &fraction[..p]) })
}

fn fractional_parts(text: &str, precision: i64) -> Result<Option<(&str, &str, usize)>> {
    let precision = precision_count(precision)?;
    let Some((whole, fraction)) = text.split_once('.') else {
        return Ok(None);
    };
    Ok(Some((whole, fraction, precision.min(fraction.len()))))
}

/// The number of fractional digits a precision names, which is between zero and six.
pub(crate) fn precision_count(precision: i64) -> Result<usize> {
    let count = usize::try_from(precision).map_err(|error| Error::Engine {
        code: codes::SCHEMA_INVALID.into(),
        msg: format!("precision {precision} is not a count of fractional digits: {error}"),
        source: None,
    })?;
    if count > 6 {
        return Err(Error::Engine { code: codes::SCHEMA_INVALID.into(), msg: format!("precision {precision} is outside 0..6"), source: None });
    }
    Ok(count)
}

/// A `time(p)` value is `HH:MM:SS` text with exactly p fractional digits (docs/spec/dbspec.md, "Runtime model"). The value is `HH:MM:SS[.f{1,6}]`
/// text; zeros after the p digits are dropped, and a nonzero digit is CODEC_ENCODE.
pub(crate) fn time_value(v: Param, precision: i64) -> Result<Param> {
    let p = precision_count(precision)?;
    let text = match v {
        Param::Null => return Ok(Param::Null),
        Param::Str(text) => text,
        _ => return Err(invalid_time_text("time")),
    };
    let full = message_time_text(&text, "time", &Zone)?;
    let (whole, fraction) = full.split_at(8);
    let p = p.min(6);
    if fraction[1 + p..].bytes().any(|b| b != b'0') {
        return Err(invalid_time_text("time"));
    }
    Ok(Param::Str(if p == 0 { whole.to_owned() } else { format!("{whole}{}", &fraction[..1 + p]) }))
}

/// The CODEC_ENCODE of a value that its date, time or datetime type does not hold, which names no value (INT-163).
fn invalid_time_text(col_type: &str) -> Error {
    Error::Engine { code: codes::CODEC_ENCODE.into(), msg: format!("{col_type} value is not a {col_type}"), source: None }
}
