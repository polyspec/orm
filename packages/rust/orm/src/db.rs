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
pub use crate::driver::{NOW_MASK, SECRET_MASK};
use crate::engine::{self, Dialect};
use crate::events::{statement_kind, Sent, Subscribers, KIND_UTILITY};
use crate::markdown::{open_markdown, parse_markdown_dsn, MarkdownDsn, MdPool};
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
    /// Key of aes_version for aes writes; empty takes aes_keys[aes_version]
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
    /// A corpus that a flowmark server serves (docs/spec/protocol.md §5 "IR executors").
    Markdown(MarkdownDsn),
}

/// A DSN URI split into driver options and the connection time zone. The
/// scheme selects the database; the `timezone` parameter accepts only UTC.
pub struct ParsedDsn {
    pub options: ConnectOptions,
    pub zone: Zone,
}

impl ParsedDsn {
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
    String::from_utf8(out).map_err(|_| Error::Config(format!("{scheme} DSN path must be UTF-8 after percent-decoding")))
}

/// Parses a DSN URI.
pub fn parse_dsn(dsn: &str) -> Result<ParsedDsn> {
    let bad = |msg: String| Error::Config(msg);
    let url = url::Url::parse(dsn).map_err(|_| bad("dsn must be a URI using mysql://, postgres://, sqlite://, or markdown://".into()))?;
    let mut zone_text = None;
    let mut pragmas = Vec::new();
    let mut rest = url.clone();
    rest.set_query(None);
    let mut pairs = Vec::new();
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "timezone" => zone_text = Some(v.into_owned()),
            "_pragma" if url.scheme() == "sqlite" => pragmas.push(v.into_owned()),
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
            ConnectOptions::MySql(MySqlConnectOptions::from_str(rest.as_str()).map_err(sqlx_err)?.timezone(Some("+00:00".to_owned())))
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
                    let ms: u64 = value.parse().map_err(|_| bad(format!("sqlite busy_timeout {value:?}")))?;
                    o.busy_timeout(std::time::Duration::from_millis(ms))
                } else {
                    o.pragma(name.to_owned(), value.to_owned())
                };
            }
            ConnectOptions::Sqlite(o)
        }
        "markdown" => ConnectOptions::Markdown(parse_markdown_dsn(&url, &decoded_path(url.path(), "markdown")?, &pairs)?),
        other => return Err(bad(format!("unsupported DSN scheme {other:?}; want mysql, postgres, sqlite, or markdown"))),
    };
    Ok(ParsedDsn { options, zone })
}

/// The session sql_mode of every MySQL connection, so that a coercion, truncation
/// or grouping result does not depend on the server's setting
/// (tests/dsn/mysql-session.json, docs/spec/config.md "Runtime connection").
const MYSQL_SQL_MODE: &str = "STRICT_ALL_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";

/// The connection pool of a database, or of the flowmark server connections of
/// a markdown corpus.
#[derive(Clone)]
pub enum Pool {
    MySql(MySqlPool),
    Postgres(PgPool),
    Sqlite(SqlitePool),
    Markdown(Arc<MdPool>),
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
}

static NEXT_DB: AtomicU64 = AtomicU64::new(1);

pub(crate) struct DbInner {
    pub(crate) id: u64,
    pub(crate) pool: Pool,
    /// The dialect a SQL connection plans for. Markdown connections, which do not plan, have none.
    pub(crate) dialect: Option<Dialect>,
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DbStats {
    /// The pool size the connection was opened with.
    pub max_open_connections: u32,
    pub open_connections: u32,
    pub idle: u32,
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
            return Err(Error::Config("aes_version must be positive".into()));
        }
        for (version, key) in &cfg.aes_keys {
            if *version <= 0 || key.is_empty() {
                return Err(Error::Config(format!("aes_keys[{version}] requires a positive version and nonempty key")));
            }
        }
        if cfg.aes_keys.is_empty() {
            if !cfg.aes_key.is_empty() {
                cfg.aes_keys.insert(cfg.aes_version, cfg.aes_key.clone());
            }
        } else {
            let current = cfg.aes_keys.get(&cfg.aes_version).ok_or_else(|| Error::Config(format!("aes_keys[{}] is missing", cfg.aes_version)))?;
            if cfg.aes_key.is_empty() {
                cfg.aes_key = current.clone();
            } else if &cfg.aes_key != current {
                return Err(Error::Config(format!("aes_key differs from aes_keys[{}]", cfg.aes_version)));
            }
        }
        let pool_size = if pool_size == 0 { DEFAULT_POOL_SIZE } else { pool_size };
        if cfg.pool_idle_size > pool_size {
            return Err(Error::Config(format!("pool idle size must be between 0 and the pool size {pool_size}")));
        }
        let idle = if cfg.pool_idle_size == 0 { pool_size } else { cfg.pool_idle_size };
        let owner = PoolOwner::default();
        let parsed = parse_dsn(dsn)?;
        let dialect = Dialect::parse(parsed.driver());
        let cache = cfg.statement_cache_size;
        let timeout = cfg.statement_timeout_ms;
        let pool = match parsed.options {
            ConnectOptions::Markdown(dsn) => Pool::Markdown(open_markdown(dsn, pool_size, idle, &cfg).await?),
            // MySQL bounds SELECT statements with max_execution_time;
            // PostgreSQL bounds every statement with statement_timeout.
            ConnectOptions::MySql(o) => Pool::MySql(
                pool_options::<sqlx::MySql>(pool_size, idle, cfg.pool_lifetime_ms, &owner)
                    .after_connect(move |conn, _| {
                        Box::pin(async move {
                            // sqlx adds PIPES_AS_CONCAT and NO_ENGINE_SUBSTITUTION to the
                            // server's sql_mode, and the IGNORE_SPACE client flag adds that
                            // mode; this replaces them with the declared one.
                            sqlx::query(sqlx::AssertSqlSafe(format!("SET SESSION sql_mode = '{MYSQL_SQL_MODE}'"))).execute(&mut *conn).await?;
                            if timeout > 0 {
                                sqlx::query(sqlx::AssertSqlSafe(format!("SET SESSION max_execution_time = {timeout}"))).execute(&mut *conn).await?;
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
            ConnectOptions::Sqlite(o) => {
                let o = if timeout > 0 { o.busy_timeout(std::time::Duration::from_millis(timeout as u64)) } else { o };
                let pool = pool_options::<sqlx::Sqlite>(pool_size, idle, cfg.pool_lifetime_ms, &owner).connect_with(o.statement_cache_capacity(cache)).await?;
                // The version of the SQLite library bundled by sqlx. No statement asking for it is sent.
                let version = libsqlite3_sys::SQLITE_VERSION.to_str().map_err(|_| Error::internal("the SQLite library version is not UTF-8"))?;
                let mut parts = version.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
                let (major, minor) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
                if major < 3 || (major == 3 && minor < 46) {
                    return Err(Error::Engine { code: codes::CAPABILITY_UNSUPPORTED.into(), msg: format!("SQLite {version} is older than 3.46") });
                }
                Pool::Sqlite(pool)
            }
        };
        let db = Db {
            inner: Arc::new(DbInner {
                id: NEXT_DB.fetch_add(1, Ordering::Relaxed),
                pool,
                dialect,
                cfg,
                zone: parsed.zone,
                plans: Mutex::new(HashMap::new()),
                plan_order: Mutex::new(VecDeque::new()),
                sets: std::sync::RwLock::new(std::collections::HashSet::new()),
                schemas: std::sync::RwLock::new(Vec::new()),
                closed: AtomicBool::new(false),
                sqlite_lock_ready: AtomicBool::new(false),
                subscribers: Subscribers::default(),
                rollback_fault: AtomicBool::new(false),
                #[cfg(feature = "test-faults")]
                statement_fault: Mutex::new(None),
                #[cfg(feature = "test-faults")]
                fixed_clock: Mutex::new(None),
                #[cfg(feature = "test-faults")]
                last_affected: Mutex::new(None),
            }),
            hook: None,
        };
        let _ = owner.set(Arc::downgrade(&db.inner));
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
        DbStats { max_open_connections: max, open_connections: size, idle: idle as u32 }
    }

    /// Closes the pool and clears cached plans. Calling it more than once is safe.
    pub async fn close(&self) {
        self.inner.closed.store(true, Ordering::Release);
        self.inner.plans.lock().unwrap().clear();
        self.inner.plan_order.lock().unwrap().clear();
        match &self.inner.pool {
            Pool::MySql(pool) => pool.close().await,
            Pool::Postgres(pool) => pool.close().await,
            Pool::Sqlite(pool) => pool.close().await,
            Pool::Markdown(pool) => pool.close(),
        }
    }

    /// Plans (or fetches from cache) the statements of the request's shape.
    pub(crate) async fn plan(&self, req: &mut Req) -> Result<Arc<Plan>> {
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
            });
        }
        let Some(dialect) = self.inner.dialect else { return Err(Error::internal("a markdown connection plans no request")) };
        let key = req.shape_key();
        if let Some(p) = self.inner.plans.lock().unwrap().get(&key) {
            return Ok(p.clone());
        }
        let mut plan = engine::compile(&manifest, dialect, &req.ir)?;
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
        let sqlite = matches!(self.inner.pool, Pool::Sqlite(_));
        let mut out = Vec::with_capacity(st.bind_slots.len() + parent_vals.len());
        let mut clock: Option<String> = None;
        for b in &st.bind_slots {
            match b.from.as_str() {
                "parent" => out.extend(parent_vals.iter().cloned()),
                "param" => {
                    // A transformed value is the text of its operator, and a host-styled value is the input of its
                    // first stage, which host_encode checks.
                    if let Some(v) = params.get(b.param) {
                        crate::bind_check::check_assign(b.param, v, &crate::bind_check::bind_slot_type(b))?;
                    }
                    if b.transform.is_empty() && b.host_styles.is_empty() {
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
                        let precision = u8::try_from(b.precision)
                            .map_err(|_| Error::Engine { code: codes::SCHEMA_INVALID.into(), msg: format!("invalid decimal precision {}", b.precision) })?;
                        let scale = u8::try_from(b.scale)
                            .map_err(|_| Error::Engine { code: codes::SCHEMA_INVALID.into(), msg: format!("invalid decimal scale {}", b.scale) })?;
                        v = match v {
                            Param::Null => Param::Null,
                            Param::Str(text) if sqlite => Param::I64(crate::decimal::scaled(&text, precision, scale)?),
                            Param::Str(text) => Param::Str(crate::decimal::normalize(&text, precision, scale)?),
                            other => {
                                return Err(Error::Engine {
                                    code: codes::CODEC_ENCODE.into(),
                                    msg: format!("decimal bind requires exact text, received {other:?}"),
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
                "secret" => match b.name.as_str() {
                    "aes" if !cfg.aes_key.is_empty() => out.push(Param::Str(cfg.aes_key.clone())),
                    _ => return Err(Error::Config(format!("secret {} is not configured", b.name))),
                },
                "config" => match b.name.as_str() {
                    "aes_version" => out.push(Param::I64(cfg.aes_version as i64)),
                    _ => return Err(Error::Config(format!("config value {} is not configured", b.name))),
                },
                "now" => {
                    // One statement reads the clock once, so its clock columns are equal.
                    let text = clock.get_or_insert_with(|| self.now_text()).clone();
                    out.push(Param::Str(clock_digits(&text, b.precision)));
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
        if matches!(self.inner.pool, Pool::Sqlite(_)) {
            for v in &mut out {
                if let Param::DateTime(t) = v {
                    *v = Param::Str(t.format(SQLITE_DATETIME).to_string());
                }
            }
        }
        Ok(out)
    }

    /// The bind as shown in the statement event: the values with the `secret` and `now` slots masked.
    fn shown<'a>(&self, st: &Step, args: &'a [Param], n_parent: usize) -> std::borrow::Cow<'a, [Param]> {
        if st.bind_slots.iter().any(|b| b.from == "secret" || b.from == "now") {
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
            return r;
        }
        let binds = shown();
        let tables = origin.tables.unwrap_or(&st.tables);
        self.statement_done(
            Sent { sql, binds: &binds, kind: origin.kind.unwrap_or_else(|| statement_kind(&st.sql)), tables, transaction: origin.transaction },
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
            Target::Tx(TxInner::Sqlite(tx)) => tx,
            Target::Pool(Pool::Sqlite(_)) => return Err(Error::Config("SQLite row locks require an ORM transaction".into())),
            _ => return Ok(()),
        };
        let nowait = mode.ends_with("_nowait");
        let mut previous = None;
        if nowait {
            let read = "PRAGMA busy_timeout";
            let start = std::time::Instant::now();
            let r = sqlx::query_scalar::<_, i64>(read).fetch_one(&mut **tx).await.map_err(Error::from);
            previous = Some(self.statement_done(Sent::bare(KIND_UTILITY, &[], transaction, read), start, r)?);
            crate::events::raw(self, &mut **tx, Sent::bare(KIND_UTILITY, &[], transaction, "PRAGMA busy_timeout=0")).await?;
        }
        let tables = [crate::tx::ROW_LOCK_TABLE.to_owned()];
        let insert = "INSERT INTO \"orm__row_lock\" (\"id\") VALUES (1) ON CONFLICT (\"id\") DO UPDATE SET \"id\"=excluded.\"id\"";
        let statement = sqlx::SqlSafeStr::into_sql_str(sqlx::AssertSqlSafe(insert));
        let start = std::time::Instant::now();
        let result = sqlx::raw_sql(statement).execute(&mut **tx).await.map(drop).map_err(|error| {
            let busy = crate::sqlite_busy(&error);
            let mapped = Error::from(error);
            if nowait && busy {
                Error::Engine { code: crate::codes::LOCK_NOT_AVAILABLE.into(), msg: mapped.to_string() }
            } else {
                mapped
            }
        });
        let result = self.statement_done(Sent::bare(KIND_UTILITY, &tables, transaction, insert), start, result);
        if let Some(previous) = previous {
            // A failure of the statement that reverts the wait does not change the result of the lock request.
            let restore = format!("PRAGMA busy_timeout={previous}");
            let _ = crate::events::raw(self, &mut **tx, Sent::bare(KIND_UTILITY, &[], transaction, &restore)).await;
        }
        result
    }

    pub(crate) async fn run_query(
        &self,
        mut target: Target<'_>,
        origin: Origin<'_>,
        st: &Step,
        params: &[Param],
        parent_vals: Vec<Param>,
        audit: Option<&AuditKey>,
    ) -> Result<Vec<DriverRow>> {
        let (sql, parent_vals) = statement(st, parent_vals, matches!(self.inner.pool, Pool::Postgres(_)));
        let args = self.args(st, params, &parent_vals, audit)?;
        // A configured statement fault ends this statement without sending it. The row lock statement is not sent either.
        #[cfg(feature = "test-faults")]
        if let Some(error) = crate::testing::take_statement_fault(self) {
            return self.step_done(st, origin, &sql, || self.shown(st, &args, parent_vals.len()), std::time::Instant::now(), Err(error));
        }
        self.sqlite_row_lock(&mut target, origin.transaction, &st.lock).await?;
        let start = std::time::Instant::now();
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
            Target::Pool(Pool::Markdown(_)) | Target::Tx(TxInner::Markdown(_)) => Err(Error::internal("a markdown connection sends no statement")),
        };
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
        let r: Result<(u64, u64)> = match target {
            Target::Pool(Pool::MySql(p)) => exec_mysql_pool(sql, &args, p).await.map_err(Error::from),
            Target::Tx(TxInner::MySql(t)) => {
                exec_mysql(sql, &args, &mut **t.conn.as_mut().expect("active MySQL transaction connection")).await.map_err(Error::from)
            }
            Target::Pool(Pool::Postgres(p)) => exec_pg_pool(sql, &args, &arg_types(st, 0), p).await,
            Target::Tx(TxInner::Postgres(t)) => exec_pg(sql, &args, &arg_types(st, 0), &mut **t).await,
            Target::Pool(Pool::Sqlite(p)) => exec_sqlite_pool(sql, &args, p).await.map_err(Error::from),
            Target::Tx(TxInner::Sqlite(t)) => exec_sqlite(sql, &args, &mut **t).await.map_err(Error::from),
            Target::Pool(Pool::Markdown(_)) | Target::Tx(TxInner::Markdown(_)) => Err(Error::internal("a markdown connection sends no statement")),
        };
        self.step_done(st, origin, sql, || self.shown(st, &args, 0), start, r)
    }

    /// The statement of a request without executing it.
    pub(crate) async fn statement(&self, req: &mut Req) -> Result<Statement> {
        self.unsupported_on_markdown("get_query")?;
        let plan = self.plan(req).await?;
        let st = &plan.steps[0];
        let audit = crate::tx::active_for(self).and_then(|t| t.audit());
        let args = self.args(st, &req.params, &[], audit.as_ref())?;
        let mut binds = Vec::with_capacity(args.len());
        for (b, a) in st.bind_slots.iter().zip(args) {
            binds.push(match b.from.as_str() {
                "secret" => Param::Str(SECRET_MASK.into()),
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
        if matches!(ex, Executor::Db(_)) && self.inner.closed.load(Ordering::Acquire) {
            return Err(Error::Config("database is closed".into()));
        }
        if step.assemble.is_some() {
            return Err(Error::Engine { code: codes::IR_INVALID.into(), msg: "execute runs a statement without rows; the statement is a read".into() });
        }
        for (i, b) in step.bind_slots.iter().enumerate() {
            if b.from == "param" && b.param >= params.len() {
                return Err(Error::Engine {
                    code: codes::IR_INVALID.into(),
                    msg: format!("bind slot {i} reads parameter {}, but execute has {} parameters", b.param, params.len()),
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
}

/// The text and binds of a statement that was not executed.
#[derive(Debug, Clone, PartialEq)]
pub struct Statement {
    pub sql: String,
    pub binds: Vec<Param>,
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
        match self {
            Executor::Db(d) => {
                if d.inner.closed.load(Ordering::Acquire) {
                    return Err(Error::Config("database is closed".into()));
                }
                if !st.lock.is_empty() {
                    return Err(Error::Config("row locks are allowed only inside a transaction".into()));
                }
                d.run_query(Target::Pool(&d.inner.pool), origin, st, params, parent_vals, None).await
            }
            Executor::Tx(t) => {
                let mut guard = t.enter()?;
                let inner = guard.as_mut().ok_or_else(|| Error::Config("transaction already finished".into()))?;
                let audit = t.audit();
                t.db.run_query(Target::Tx(inner), origin, st, params, parent_vals, audit.as_ref()).await
            }
        }
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
        match self {
            Executor::Db(d) => {
                if d.inner.closed.load(Ordering::Acquire) {
                    return Err(Error::Config("database is closed".into()));
                }
                d.run_execute(Target::Pool(&d.inner.pool), origin, st, params, None).await
            }
            Executor::Tx(t) => {
                let mut guard = t.enter()?;
                let inner = guard.as_mut().ok_or_else(|| Error::Config("transaction already finished".into()))?;
                let audit = t.audit();
                t.db.run_execute(Target::Tx(inner), origin, st, params, audit.as_ref()).await
            }
        }
    }
}

fn digits(b: &[u8]) -> bool {
    b.iter().all(u8::is_ascii_digit)
}

/// A date or datetime bind in the text form SQLite stores (Db::bind_time_value) in the connection time zone `zone`.
pub(crate) fn bound_time_value(v: Param, col_type: &str, precision: i64, zone: &Zone) -> Result<Param> {
    match v {
        Param::DateTime(t) if col_type == "date" => Ok(Param::Str(t.format("%Y-%m-%d").to_string())),
        Param::Str(text) if col_type == "date" => {
            if sqlite_date_text(&text) {
                Ok(Param::Str(text))
            } else {
                Err(invalid_time_text(&text, col_type))
            }
        }
        Param::DateTime(t) => datetime_digits(&t.format(SQLITE_DATETIME).to_string(), precision).map(Param::Str),
        Param::Str(text) => {
            let full = sqlite_datetime_text(&text, zone).ok_or_else(|| invalid_time_text(&text, col_type))?;
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
fn sqlite_datetime_text(text: &str, zone: &Zone) -> Option<String> {
    let (body, offset) = if let Some(body) = text.strip_suffix('Z') {
        (body, Some(0))
    } else {
        let b = text.as_bytes();
        let n = b.len();
        if n >= 6 && (b[n - 6] == b'+' || b[n - 6] == b'-') && b[n - 3] == b':' && digits(&b[n - 5..n - 3]) && digits(&b[n - 2..]) {
            let minutes = (text[n - 5..n - 3].parse::<i32>().ok()? * 60 + text[n - 2..].parse::<i32>().ok()?) * if b[n - 6] == b'-' { -1 } else { 1 };
            (&text[..n - 6], Some(minutes))
        } else {
            (text, None)
        }
    };
    let b = body.as_bytes();
    if b.len() < 19 || !sqlite_date_text(&body[..10]) || !(b[10] == b' ' || b[10] == b'T') {
        return None;
    }
    if !(digits(&b[11..13]) && b[13] == b':' && digits(&b[14..16]) && b[16] == b':' && digits(&b[17..19])) {
        return None;
    }
    let fraction = match &b[19..] {
        [] => "",
        [b'.', rest @ ..] if (1..=6).contains(&rest.len()) && digits(rest) => &body[20..],
        _ => return None,
    };
    let wall = format!("{} {}.{:0<6}", &body[..10], &body[11..19], fraction);
    let t = NaiveDateTime::parse_from_str(&wall, "%Y-%m-%d %H:%M:%S%.6f").ok()?;
    match offset {
        None => Some(wall),
        Some(minutes) => {
            let instant = t.checked_sub_signed(chrono::Duration::minutes(i64::from(minutes)))?.and_utc();
            Some(format!("{}.{:0<6}", zone.local(instant).format("%Y-%m-%d %H:%M:%S"), fraction))
        }
    }
}

/// The date, time, and datetime text of an IR executor message (docs/spec/protocol.md §5 "Parameters"): date is `YYYY-MM-DD`,
/// time is `HH:MM:SS.ffffff`, and datetime is `YYYY-MM-DD HH:MM:SS.ffffff` in the connection time zone; fractional digits the value lacks are 0.
/// Text in any other form is CODEC_ENCODE.
pub(crate) fn message_time_text(text: &str, col_type: &str, zone: &Zone) -> Result<String> {
    match col_type {
        "date" if sqlite_date_text(text) => Ok(text.to_owned()),
        "date" => Err(invalid_time_text(text, col_type)),
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
                _ => Err(Error::Engine { code: codes::CODEC_ENCODE.into(), msg: format!("time value {text:?} is not HH:MM:SS[.ffffff]") }),
            }
        }
        _ => sqlite_datetime_text(text, zone).ok_or_else(|| invalid_time_text(text, col_type)),
    }
}

/// Shortens a six-fractional-digit `YYYY-MM-DD HH:MM:SS.ffffff` text to p fractional digits. If a nonzero digit
/// is in the dropped digits, the value changes, so it is CODEC_ENCODE.
fn datetime_digits(text: &str, precision: i64) -> Result<String> {
    let Some((whole, fraction)) = text.split_once('.') else {
        return Ok(text.to_owned());
    };
    let p = usize::try_from(precision).unwrap_or(0).min(fraction.len());
    if fraction[p..].bytes().any(|b| b != b'0') {
        return Err(Error::Engine { code: codes::CODEC_ENCODE.into(), msg: format!("datetime value {text:?} has more than {p} fraction digits") });
    }
    Ok(if p == 0 { whole.to_owned() } else { format!("{whole}.{}", &fraction[..p]) })
}

/// Truncates the six-digit fractional text of the executor clock to the p fractional digits of a `datetime(p)` column.
fn clock_digits(text: &str, precision: i64) -> String {
    let Some((whole, fraction)) = text.split_once('.') else {
        return text.to_owned();
    };
    let p = usize::try_from(precision).unwrap_or(0).min(fraction.len());
    if p == 0 {
        whole.to_owned()
    } else {
        format!("{whole}.{}", &fraction[..p])
    }
}

/// A `time(p)` value is `HH:MM:SS` text with exactly p fractional digits (docs/spec/dbspec.md, "Runtime model"). The value is `HH:MM:SS[.f{1,6}]`
/// text; zeros after the p digits are dropped, and a nonzero digit is CODEC_ENCODE.
pub(crate) fn time_value(v: Param, precision: i64) -> Result<Param> {
    let text = match v {
        Param::Null => return Ok(Param::Null),
        Param::Str(text) => text,
        other => return Err(Error::Engine { code: codes::CODEC_ENCODE.into(), msg: format!("time value must be HH:MM:SS text, received {other:?}") }),
    };
    let full = message_time_text(&text, "time", &Zone)?;
    let (whole, fraction) = full.split_at(8);
    let p = usize::try_from(precision).unwrap_or(0).min(6);
    if fraction[1 + p..].bytes().any(|b| b != b'0') {
        return Err(Error::Engine { code: codes::CODEC_ENCODE.into(), msg: format!("time value {text:?} has more than {p} fraction digits") });
    }
    Ok(Param::Str(if p == 0 { whole.to_owned() } else { format!("{whole}{}", &fraction[..1 + p]) }))
}

fn invalid_time_text(text: &str, col_type: &str) -> Error {
    let form = if col_type == "date" { "YYYY-MM-DD" } else { "YYYY-MM-DD HH:MM:SS[.ffffff][Z|±HH:MM]" };
    Error::Engine { code: codes::CODEC_ENCODE.into(), msg: format!("{col_type} value {text:?} is not {form}") }
}
