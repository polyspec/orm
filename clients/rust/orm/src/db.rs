//! A database connection: the pool, the plan cache, and the executor that
//! runs a statement on the pool or on an active transaction.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{FixedOffset, NaiveDateTime, Utc};
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgTypeInfo};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

use crate::driver::{
    acquire_sqlite_row_lock, exec_mysql, exec_pg, exec_sqlite, fetch_mysql, fetch_pg, fetch_sqlite, masked, param_arg, pg_describe, statement, Target, TxInner,
};
pub use crate::driver::{NOW_MASK, SECRET_MASK};
use crate::engine::{self, Dialect};
use crate::plan::{Plan, Step};
use crate::request::Req;
use crate::row::DriverRow;
use crate::tx::TxShared;
use crate::value::Param;
use crate::{codes, Error, Result};

/// The statement hook: `(sql, binds, duration, plan_id, err)`. Secret binds
/// arrive as `$SECRET` and executor clock binds as `$NOW`.
pub type OnQuery = Arc<dyn Fn(&str, &[Param], std::time::Duration, u64, Option<&Error>) + Send + Sync>;

/// The connection configuration: declared, never discovered.
#[derive(Clone)]
pub struct Config {
    /// Key of aes_version for aes writes; empty takes aes_keys[aes_version].
    pub aes_key: String,
    pub blind_index_key: String,
    pub aes_version: i32,
    pub aes_keys: BTreeMap<i32, String>,
    pub plan_cache_size: usize,
    pub statement_cache_size: usize,
    /// Bound of every statement of the connection in milliseconds; zero keeps
    /// the server default.
    pub statement_timeout_ms: u32,
    pub on_query: Option<OnQuery>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            aes_key: String::new(),
            blind_index_key: String::new(),
            aes_version: 1,
            aes_keys: BTreeMap::new(),
            statement_timeout_ms: 0,
            plan_cache_size: 256,
            statement_cache_size: 256,
            on_query: None,
        }
    }
}

const SQLITE_DATETIME: &str = "%Y-%m-%d %H:%M:%S%.6f";

/// The time zone of a connection.
#[derive(Clone, Copy, Debug)]
pub enum Zone {
    Local,
    Fixed(FixedOffset),
    Named(chrono_tz::Tz),
}

impl Zone {
    fn parse(value: &str) -> Result<Zone> {
        let b = value.as_bytes();
        if b.len() == 6 && (b[0] == b'+' || b[0] == b'-') && b[3] == b':' {
            let hours: i32 = value[1..3].parse().map_err(|_| Error::Config(format!("dsn timezone {value:?}")))?;
            let minutes: i32 = value[4..6].parse().map_err(|_| Error::Config(format!("dsn timezone {value:?}")))?;
            let secs = (hours * 3600 + minutes * 60) * if b[0] == b'-' { -1 } else { 1 };
            return FixedOffset::east_opt(secs).map(Zone::Fixed).ok_or_else(|| Error::Config(format!("dsn timezone {value:?}")));
        }
        chrono_tz::Tz::from_str(value).map(Zone::Named).map_err(|_| Error::Config(format!("dsn timezone {value:?} is not a time zone")))
    }

    /// The current time in the zone.
    pub fn now(&self) -> chrono::DateTime<FixedOffset> {
        self.at(Utc::now())
    }

    /// An instant in the zone.
    pub fn at(&self, t: chrono::DateTime<Utc>) -> chrono::DateTime<FixedOffset> {
        match self {
            Zone::Local => t.with_timezone(&chrono::Local).fixed_offset(),
            Zone::Fixed(o) => t.with_timezone(o),
            Zone::Named(z) => t.with_timezone(z).fixed_offset(),
        }
    }

    /// The instant of a wall-clock time in the zone; the earlier one when the
    /// time occurs twice, None when it does not occur.
    pub fn instant(&self, t: NaiveDateTime) -> Option<chrono::DateTime<Utc>> {
        use chrono::TimeZone;
        match self {
            Zone::Local => chrono::Local.from_local_datetime(&t).earliest().map(|x| x.to_utc()),
            Zone::Fixed(o) => o.from_local_datetime(&t).earliest().map(|x| x.to_utc()),
            Zone::Named(z) => z.from_local_datetime(&t).earliest().map(|x| x.to_utc()),
        }
    }

    /// An instant as wall-clock time in the zone.
    pub fn local(&self, t: chrono::DateTime<Utc>) -> NaiveDateTime {
        self.at(t).naive_local()
    }
}

/// The connection options selected by a DSN URI.
pub enum ConnectOptions {
    MySql(MySqlConnectOptions),
    Postgres(PgConnectOptions),
    Sqlite(SqliteConnectOptions),
}

/// A DSN URI split into driver options and the connection time zone. The
/// scheme selects the database; the optional `timezone` parameter sets the
/// connection time zone, otherwise the server environment's is used.
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
        }
    }
}

/// A fixed offset in the POSIX form PostgreSQL expects, where the sign after
/// the name is inverted: +09:00 becomes <+09:00>-09:00. Named zones pass through.
fn postgres_zone(zone: &str) -> String {
    let b = zone.as_bytes();
    if b.len() == 6 && (b[0] == b'+' || b[0] == b'-') && b[3] == b':' {
        let inverted = if b[0] == b'-' { '+' } else { '-' };
        return format!("<{zone}>{inverted}{}", &zone[1..]);
    }
    zone.to_owned()
}

/// Parses a DSN URI.
pub fn parse_dsn(dsn: &str) -> Result<ParsedDsn> {
    let bad = |msg: String| Error::Config(msg);
    let url = url::Url::parse(dsn).map_err(|_| bad("dsn must be a URI using mysql://, postgres://, or sqlite://".into()))?;
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
                if v != "deferred" {
                    return Err(bad("sqlite DSN _txlock must be deferred".into()));
                }
            }
            _ => pairs.push((k.into_owned(), v.into_owned())),
        }
    }
    if !pairs.is_empty() {
        rest.query_pairs_mut().extend_pairs(pairs.iter());
    }
    let zone = match &zone_text {
        Some(z) => Zone::parse(z)?,
        None => Zone::Local,
    };
    let sqlx_err = |e: sqlx::Error| Error::Config(format!("dsn: {e}"));
    let options = match url.scheme() {
        "mysql" => {
            if url.host_str().unwrap_or("").is_empty() || url.path().trim_matches('/').is_empty() {
                return Err(bad("mysql DSN must include host and database".into()));
            }
            ConnectOptions::MySql(MySqlConnectOptions::from_str(rest.as_str()).map_err(sqlx_err)?.timezone(zone_text.clone()))
        }
        "postgres" => {
            let host = url.host_str().unwrap_or("").to_owned() + &pairs.iter().filter(|(k, _)| k == "host").map(|(_, v)| v.clone()).collect::<String>();
            if host.is_empty() || url.path().trim_matches('/').is_empty() {
                return Err(bad("postgres DSN must include host and database".into()));
            }
            // The server default extra_float_digits of PostgreSQL 12 and later
            // prints float8 values exactly, and a pooler rejects a startup
            // parameter it does not track, so the connection sends none.
            let mut o = PgConnectOptions::from_str(rest.as_str()).map_err(sqlx_err)?.extra_float_digits(None);
            if let Some(z) = &zone_text {
                o = o.options([("timezone", postgres_zone(z).as_str())]);
            }
            ConnectOptions::Postgres(o)
        }
        "sqlite" => {
            let path = url.path();
            if !path.starts_with('/') || path.len() < 2 {
                return Err(bad("sqlite DSN must include an absolute database path".into()));
            }
            let mut o = SqliteConnectOptions::new().filename(path).create_if_missing(true).foreign_keys(true).busy_timeout(std::time::Duration::from_secs(5));
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
        other => return Err(bad(format!("unsupported DSN scheme {other:?}; want mysql, postgres, or sqlite"))),
    };
    Ok(ParsedDsn { options, zone })
}

/// The connection pool of a database.
#[derive(Clone)]
pub enum Pool {
    MySql(MySqlPool),
    Postgres(PgPool),
    Sqlite(SqlitePool),
}

static NEXT_DB: AtomicU64 = AtomicU64::new(1);

pub(crate) struct DbInner {
    pub(crate) id: u64,
    pub(crate) pool: Pool,
    pub(crate) dialect: Dialect,
    pub(crate) cfg: Config,
    pub(crate) zone: Zone,
    plans: Mutex<HashMap<u64, Arc<Plan>>>,
    plan_order: Mutex<VecDeque<u64>>,
    pg_types: Mutex<HashMap<String, Arc<[PgTypeInfo]>>>,
    pub(crate) closed: AtomicBool,
    pub(crate) sqlite_lock_ready: AtomicBool,
}

/// A database connection. Cloning is cheap and keeps the identity.
#[derive(Clone)]
pub struct Db {
    pub(crate) inner: Arc<DbInner>,
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

impl Db {
    /// Connects to the database selected by the DSN URI with at most
    /// `pool_size` open connections; zero uses 10.
    pub async fn connect(dsn: &str, pool_size: u32, mut cfg: Config) -> Result<Db> {
        if cfg.plan_cache_size == 0 || cfg.statement_cache_size == 0 {
            return Err(Error::Config("cache sizes must be positive".into()));
        }
        let pool_size = if pool_size == 0 { DEFAULT_POOL_SIZE } else { pool_size };
        let parsed = parse_dsn(dsn)?;
        let dialect = Dialect::parse(parsed.driver()).expect("known driver");
        let cache = cfg.statement_cache_size;
        let timeout = cfg.statement_timeout_ms;
        let pool = match parsed.options {
            // MySQL bounds SELECT statements with max_execution_time;
            // PostgreSQL bounds every statement with statement_timeout.
            ConnectOptions::MySql(o) => Pool::MySql(
                MySqlPoolOptions::new()
                    .max_connections(pool_size)
                    .after_connect(move |conn, _| {
                        Box::pin(async move {
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
                Pool::Postgres(PgPoolOptions::new().max_connections(pool_size).connect_with(o.statement_cache_capacity(cache)).await?)
            }
            ConnectOptions::Sqlite(o) => {
                let pool = SqlitePoolOptions::new().max_connections(pool_size).connect_with(o.statement_cache_capacity(cache)).await?;
                let version: String = sqlx::query_scalar("SELECT sqlite_version()").fetch_one(&pool).await?;
                let mut parts = version.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
                let (major, minor) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
                if major < 3 || (major == 3 && minor < 46) {
                    return Err(Error::Engine { code: codes::CAPABILITY_UNSUPPORTED.into(), msg: format!("SQLite {version} is older than 3.46") });
                }
                Pool::Sqlite(pool)
            }
        };
        if cfg.aes_version == 0 {
            cfg.aes_version = 1;
        }
        // aes_key is the key of aes_version: writes encrypt with it, and
        // aes_keys holds it at aes_version.
        if cfg.aes_keys.is_empty() {
            if !cfg.aes_key.is_empty() {
                cfg.aes_keys.insert(cfg.aes_version, cfg.aes_key.clone());
            }
        } else if cfg.aes_key.is_empty() {
            cfg.aes_key = cfg.aes_keys.get(&cfg.aes_version).cloned().unwrap_or_default();
        } else if cfg.aes_keys.get(&cfg.aes_version) != Some(&cfg.aes_key) {
            return Err(Error::Config(format!("aes_key differs from aes_keys[{}]", cfg.aes_version)));
        }
        Ok(Db {
            inner: Arc::new(DbInner {
                id: NEXT_DB.fetch_add(1, Ordering::Relaxed),
                pool,
                dialect,
                cfg,
                zone: parsed.zone,
                plans: Mutex::new(HashMap::new()),
                plan_order: Mutex::new(VecDeque::new()),
                pg_types: Mutex::new(HashMap::new()),
                closed: AtomicBool::new(false),
                sqlite_lock_ready: AtomicBool::new(false),
            }),
        })
    }

    pub(crate) fn id(&self) -> u64 {
        self.inner.id
    }

    /// The database of the connection: mysql, postgres, or sqlite.
    pub fn driver(&self) -> &'static str {
        match &self.inner.pool {
            Pool::MySql(_) => "mysql",
            Pool::Postgres(_) => "postgres",
            Pool::Sqlite(_) => "sqlite",
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
        }
    }

    /// Plans (or fetches from cache) the statements of the request's shape.
    pub(crate) async fn plan(&self, req: &mut Req) -> Result<Arc<Plan>> {
        if let Some(e) = req.error() {
            return Err(e);
        }
        let key = req.shape_key();
        if let Some(p) = self.inner.plans.lock().unwrap().get(&key) {
            return Ok(p.clone());
        }
        let manifest = req.schema.manifest()?;
        let mut plan = engine::compile(&manifest, self.inner.dialect, &req.ir)?;
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

    /// The executor clock in the connection time zone. PostgreSQL receives the
    /// offset because its columns store instants.
    pub(crate) fn now_text(&self) -> String {
        let now = self.inner.zone.now();
        if self.inner.dialect == Dialect::Postgres {
            return now.format("%Y-%m-%d %H:%M:%S%.6f%:z").to_string();
        }
        now.format(SQLITE_DATETIME).to_string()
    }

    /// Writes a datetime or date value in the text form SQLite stores, so a
    /// string value compares equal to the stored value. A datetime string with
    /// an offset is converted to the connection time zone.
    fn sqlite_time_value(&self, v: Param, col_type: &str) -> Result<Param> {
        match v {
            Param::DateTime(t) if col_type == "date" => Ok(Param::Str(t.format("%Y-%m-%d").to_string())),
            Param::Str(text) if col_type == "date" => {
                if sqlite_date_text(&text) {
                    Ok(Param::Str(text))
                } else {
                    Err(invalid_time_text(&text, col_type))
                }
            }
            Param::Str(text) => sqlite_datetime_text(&text, &self.inner.zone).map(Param::Str).ok_or_else(|| invalid_time_text(&text, col_type)),
            other => Ok(other),
        }
    }

    /// Resolves the bind slots of a step.
    pub(crate) fn args(&self, st: &Step, params: &[Param], parent_vals: &[Param]) -> Result<Vec<Param>> {
        let cfg = &self.inner.cfg;
        let postgres = matches!(self.inner.pool, Pool::Postgres(_));
        let sqlite = matches!(self.inner.pool, Pool::Sqlite(_));
        let mut out = Vec::with_capacity(st.bind_slots.len() + parent_vals.len());
        let mut clock: Option<String> = None;
        for b in &st.bind_slots {
            match b.from.as_str() {
                "parent" => out.extend(parent_vals.iter().cloned()),
                "param" => {
                    let mut v = param_arg(b, params)?;
                    if sqlite && (b.col_type == "datetime" || b.col_type == "date") {
                        v = self.sqlite_time_value(v, &b.col_type)?;
                    }
                    if b.col_type == "point" {
                        v = match v {
                            Param::Null => Param::Null,
                            Param::Point(point) => {
                                Param::Str(if postgres { crate::value::postgres_point_text(point)? } else { crate::value::point_text(point)? })
                            }
                            Param::Str(text) => {
                                let point = crate::value::parse_point(&text)?;
                                Param::Str(if postgres { crate::value::postgres_point_text(point)? } else { crate::value::point_text(point)? })
                            }
                            other => return Err(Error::Config(format!("point parameter requires two coordinates, received {other:?}"))),
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
                    out.push(Param::Str(text));
                }
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

    /// The binds of a statement as a hook shows them.
    pub(crate) fn shown(&self, st: &Step, args: &[Param], n_parent: usize) -> Vec<Param> {
        if st.bind_slots.iter().any(|b| b.from == "secret" || b.from == "now") {
            masked(st, args, n_parent)
        } else {
            args.to_vec()
        }
    }

    /// Reports a model statement to the hook; utility statements are not reported.
    fn emit(&self, st: &Step, sql: &str, args: &[Param], n_parent: usize, start: std::time::Instant, err: Option<&Error>) {
        if st.role == "utils" {
            return;
        }
        if let Some(h) = &self.inner.cfg.on_query {
            h(sql, &self.shown(st, args, n_parent), start.elapsed(), st.plan_id, err);
        }
    }

    async fn pg_types_pool(&self, pool: &PgPool, sql: &str) -> Result<Arc<[PgTypeInfo]>> {
        if let Some(t) = self.inner.pg_types.lock().unwrap().get(sql) {
            return Ok(t.clone());
        }
        let mut conn = pool.acquire().await?;
        let t = pg_describe(&mut *conn, sql).await?;
        self.inner.pg_types.lock().unwrap().insert(sql.to_owned(), t.clone());
        Ok(t)
    }

    async fn pg_types_conn(&self, conn: &mut sqlx::PgConnection, sql: &str) -> Result<Arc<[PgTypeInfo]>> {
        if let Some(t) = self.inner.pg_types.lock().unwrap().get(sql) {
            return Ok(t.clone());
        }
        let t = pg_describe(conn, sql).await?;
        self.inner.pg_types.lock().unwrap().insert(sql.to_owned(), t.clone());
        Ok(t)
    }

    pub(crate) async fn run_query(&self, mut target: Target<'_>, st: &Step, params: &[Param], parent_vals: Vec<Param>) -> Result<Vec<DriverRow>> {
        acquire_sqlite_row_lock(&mut target, &st.lock).await?;
        let (sql, parent_vals) = statement(st, parent_vals, matches!(self.inner.pool, Pool::Postgres(_)));
        let args = self.args(st, params, &parent_vals)?;
        let start = std::time::Instant::now();
        let r: Result<Vec<DriverRow>> = match target {
            Target::Pool(Pool::MySql(p)) => fetch_mysql(&sql, &args, p).await.map(|v| v.into_iter().map(DriverRow::MySql).collect()).map_err(Error::from),
            Target::Tx(TxInner::MySql(t)) => fetch_mysql(&sql, &args, &mut **t.conn.as_mut().expect("active MySQL transaction connection"))
                .await
                .map(|v| v.into_iter().map(DriverRow::MySql).collect())
                .map_err(Error::from),
            Target::Pool(Pool::Postgres(p)) => match self.pg_types_pool(p, &sql).await {
                Ok(types) => fetch_pg(&sql, &args, &types, self.inner.zone, p).await.map(|v| v.into_iter().map(DriverRow::Postgres).collect()),
                Err(e) => Err(e),
            },
            Target::Tx(TxInner::Postgres(t)) => match self.pg_types_conn(t, &sql).await {
                Ok(types) => fetch_pg(&sql, &args, &types, self.inner.zone, &mut **t).await.map(|v| v.into_iter().map(DriverRow::Postgres).collect()),
                Err(e) => Err(e),
            },
            Target::Pool(Pool::Sqlite(p)) => fetch_sqlite(&sql, &args, p).await.map(|v| v.into_iter().map(DriverRow::Sqlite).collect()).map_err(Error::from),
            Target::Tx(TxInner::Sqlite(t)) => {
                fetch_sqlite(&sql, &args, &mut **t).await.map(|v| v.into_iter().map(DriverRow::Sqlite).collect()).map_err(Error::from)
            }
        };
        self.emit(st, &sql, &args, parent_vals.len(), start, r.as_ref().err());
        r
    }

    pub(crate) async fn run_execute(&self, target: Target<'_>, st: &Step, params: &[Param]) -> Result<(u64, u64)> {
        let args = self.args(st, params, &[])?;
        let sql = st.sql.as_str();
        let start = std::time::Instant::now();
        let r: Result<(u64, u64)> = match target {
            Target::Pool(Pool::MySql(p)) => exec_mysql(sql, &args, p).await.map_err(Error::from),
            Target::Tx(TxInner::MySql(t)) => {
                exec_mysql(sql, &args, &mut **t.conn.as_mut().expect("active MySQL transaction connection")).await.map_err(Error::from)
            }
            Target::Pool(Pool::Postgres(p)) => match self.pg_types_pool(p, sql).await {
                Ok(types) => exec_pg(sql, &args, &types, self.inner.zone, p).await,
                Err(e) => Err(e),
            },
            Target::Tx(TxInner::Postgres(t)) => match self.pg_types_conn(t, sql).await {
                Ok(types) => exec_pg(sql, &args, &types, self.inner.zone, &mut **t).await,
                Err(e) => Err(e),
            },
            Target::Pool(Pool::Sqlite(p)) => exec_sqlite(sql, &args, p).await.map_err(Error::from),
            Target::Tx(TxInner::Sqlite(t)) => exec_sqlite(sql, &args, &mut **t).await.map_err(Error::from),
        };
        self.emit(st, sql, &args, 0, start, r.as_ref().err());
        r
    }

    /// The statement of a request without executing it.
    pub(crate) async fn statement(&self, req: &mut Req) -> Result<Statement> {
        let plan = self.plan(req).await?;
        let st = &plan.steps[0];
        let args = self.args(st, &req.params, &[])?;
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
}

/// The text and binds of a statement that was not executed.
#[derive(Debug, Clone, PartialEq)]
pub struct Statement {
    pub sql: String,
    pub binds: Vec<Param>,
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

    pub(crate) async fn query(&self, st: &Step, params: &[Param], parent_vals: Vec<Param>) -> Result<Vec<DriverRow>> {
        match self {
            Executor::Db(d) => {
                if d.inner.closed.load(Ordering::Acquire) {
                    return Err(Error::Config("database is closed".into()));
                }
                if !st.lock.is_empty() {
                    return Err(Error::Config("row locks are allowed only inside a transaction".into()));
                }
                d.run_query(Target::Pool(&d.inner.pool), st, params, parent_vals).await
            }
            Executor::Tx(t) => {
                let mut guard = t.enter()?;
                let inner = guard.as_mut().ok_or_else(|| Error::Config("transaction already finished".into()))?;
                t.db.run_query(Target::Tx(inner), st, params, parent_vals).await
            }
        }
    }

    pub(crate) async fn execute(&self, st: &Step, params: &[Param]) -> Result<(u64, u64)> {
        match self {
            Executor::Db(d) => {
                if d.inner.closed.load(Ordering::Acquire) {
                    return Err(Error::Config("database is closed".into()));
                }
                d.run_execute(Target::Pool(&d.inner.pool), st, params).await
            }
            Executor::Tx(t) => {
                let mut guard = t.enter()?;
                let inner = guard.as_mut().ok_or_else(|| Error::Config("transaction already finished".into()))?;
                t.db.run_execute(Target::Tx(inner), st, params).await
            }
        }
    }
}

fn digits(b: &[u8]) -> bool {
    b.iter().all(u8::is_ascii_digit)
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

fn invalid_time_text(text: &str, col_type: &str) -> Error {
    let form = if col_type == "date" { "YYYY-MM-DD" } else { "YYYY-MM-DD HH:MM:SS[.ffffff][Z|±HH:MM]" };
    Error::Engine { code: codes::CODEC_ENCODE.into(), msg: format!("{col_type} value {text:?} is not {form}") }
}
