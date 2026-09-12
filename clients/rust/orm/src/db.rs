//! The sqlx executor: plan cache keyed by IR shape, statement reuse through
//! sqlx's per-connection cache, transactions with deadlock re-run.
//!
//! One pool per database (`Pool`), one `Exec` surface. MySQL keeps its hot path: driver rows
//! go undecoded to the generated `from_row`. PostgreSQL and SQLite rows are read positionally
//! and decoded (host aes/hex/ip stages, then codec stages) before assembly, like Go does.
//! PostgreSQL binds are typed by the server's own parameter description (pgx does the same):
//! the first run of a statement text prepares it once with no declared types, and every bind
//! from then on is converted to the type the server inferred for that placeholder.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::future::Future;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{NaiveDate, NaiveDateTime};
use futures_util::TryStreamExt;
use sqlx::mysql::{MySql, MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow, PgTypeInfo, Postgres};
use sqlx::sqlite::{
    Sqlite, SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteRow,
};
use sqlx::{Executor, SqlSafeStr as _, Statement as _, TypeInfo as _};

use crate::builder::Req;
use crate::collection::Key;
use crate::compiler_bridge::{plan_from_proto, request_to_proto};
use crate::compiler_proto::GetMetadataResponse;
use crate::compiler_transport::CompilerTransport;
use crate::engine::Engine;
use crate::ir;
use crate::plan::{Assemble, BindSlot, Child, ParentRef, Plan, Step};
use crate::row::{decode_styled, read_cell, read_row, Cells, DriverRow, Src};
use crate::value::{transform, Param, Val};
use crate::{Error, Result};

/// The statement hook: `(sql, binds, duration, plan_id, err)`. Secret binds arrive masked
/// as `Param::Str("$SECRET")`; `plan_id` is the plan-cache key of the statement's plan
/// (render it as 16 lowercase hex digits, `{plan_id:016x}`, to group logs by shape).
pub type OnQuery =
    Box<dyn Fn(&str, &[Param], std::time::Duration, u64, Option<&Error>) + Send + Sync>;

/// The masked form of a secret bind in the hook payload and in `sql()`.
pub const SECRET_MASK: &str = "$SECRET";
/// Executor-supplied timestamps (`now` slots) are shown to hooks as this, so logs and recorded vectors stay deterministic.
pub const NOW_MASK: &str = "$NOW";

/// Executor configuration: declared, never discovered.
pub struct Config {
    pub aes_key: String,
    pub blind_index_key: String,
    pub aes_version: i32,
    pub aes_keys: BTreeMap<i32, String>,
    pub plan_cache_size: usize,
    pub statement_cache_size: usize,
    pub on_query: Option<OnQuery>,
}

/// SQLite datetimes are text with six fraction digits (docs/dialects.md); `now` slots and
/// bound `time` values use this form so a value read back compares equal.
const SQLITE_DATETIME: &str = "%Y-%m-%d %H:%M:%S%.6f";

/// The parsed DSN of one database. `parse(driver, dsn)` is the one place the driver name is
/// interpreted; the SQLite options carry the executor's policy (WAL, 5 s busy timeout — the
/// same pragmas the Go runner puts in its DSN) so every reader of the file behaves alike.
pub enum ConnectOptions {
    MySql(MySqlConnectOptions),
    Postgres(PgConnectOptions),
    Sqlite(SqliteConnectOptions),
}

impl ConnectOptions {
    pub fn parse(driver: &str, dsn: &str) -> Result<ConnectOptions> {
        let bad = |e: sqlx::Error| Error::Config(format!("{driver} dsn: {e}"));
        Ok(match driver {
            "mysql" => ConnectOptions::MySql(MySqlConnectOptions::from_str(dsn).map_err(bad)?),
            "postgres" => ConnectOptions::Postgres(PgConnectOptions::from_str(dsn).map_err(bad)?),
            "sqlite" => ConnectOptions::Sqlite(
                SqliteConnectOptions::from_str(dsn)
                    .map_err(bad)?
                    .busy_timeout(std::time::Duration::from_secs(5))
                    .journal_mode(SqliteJournalMode::Wal),
            ),
            other => {
                return Err(Error::Config(format!(
                    "driver {other:?}: want mysql, postgres or sqlite"
                )))
            }
        })
    }

    /// The driver these options connect with (mysql | postgres | sqlite).
    pub fn driver(&self) -> &'static str {
        match self {
            ConnectOptions::MySql(_) => "mysql",
            ConnectOptions::Postgres(_) => "postgres",
            ConnectOptions::Sqlite(_) => "sqlite",
        }
    }
}

/// The connection pool of the database this `Db` talks to.
#[derive(Clone)]
pub enum Pool {
    MySql(MySqlPool),
    Postgres(PgPool),
    Sqlite(SqlitePool),
}

/// Cheap to clone: every field is shared. `Tx` owns a clone, so no lifetimes leak into closures.
#[derive(Clone)]
pub struct Db {
    pub pool: Pool,
    pub engine: Arc<Engine>,
    compiler: Arc<dyn PlanCompiler>,
    cfg: Arc<Config>,
    plans: Arc<Mutex<HashMap<u64, Arc<Plan>>>>,
    plan_order: Arc<Mutex<VecDeque<u64>>>,
    /// PostgreSQL: the server-described parameter types of every statement text run so far.
    pg_types: Arc<Mutex<HashMap<String, Arc<[PgTypeInfo]>>>>,
}

fn canonical_json(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(values) => {
            let mut keys: Vec<String> = values.keys().cloned().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for key in keys {
                out.insert(
                    key.clone(),
                    canonical_json(values.get(&key).cloned().unwrap_or(serde_json::Value::Null)),
                );
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.into_iter().map(canonical_json).collect())
        }
        other => other,
    }
}

#[async_trait::async_trait]
trait PlanCompiler: Send + Sync {
    async fn compile(&self, request: &ir::Request) -> Result<Plan>;
    async fn metadata(&self) -> Result<GetMetadataResponse>;
}

struct TransportPlanCompiler {
    transport: Arc<dyn CompilerTransport>,
}

#[async_trait::async_trait]
impl PlanCompiler for TransportPlanCompiler {
    async fn compile(&self, request: &ir::Request) -> Result<Plan> {
        plan_from_proto(self.transport.compile(request_to_proto(request)?).await?)
    }

    async fn metadata(&self) -> Result<GetMetadataResponse> {
        self.transport.metadata().await
    }
}

struct WasmPlanCompiler {
    engine: Arc<Engine>,
}

#[async_trait::async_trait]
impl PlanCompiler for WasmPlanCompiler {
    async fn compile(&self, request: &ir::Request) -> Result<Plan> {
        let body =
            serde_json::to_vec(request).map_err(|error| Error::internal(error.to_string()))?;
        let output = self.engine.compile(&body)?;
        serde_json::from_slice(&output).map_err(|error| Error::internal(error.to_string()))
    }

    async fn metadata(&self) -> Result<GetMetadataResponse> {
        Ok(GetMetadataResponse {
            schema_hash: self.engine.schema_hash.clone(),
            dialect: self.engine.dialect.clone(),
            ir_version: 1,
        })
    }
}

/// Rows of a select plan: the main step's rows (MySQL driver rows when the plan has no
/// relation steps, positional rows otherwise) plus every relation step's rows grouped
/// by their match column (see `related`).
pub struct Rows {
    pub binding: crate::binding::Binding,
    pub assemble: Arc<Assemble>,
    cells: Vec<Cells>,
    plan: Arc<Plan>,
    steps: HashMap<u32, StepRows>,
    params: Vec<Param>,
}

struct StepRows {
    data: Vec<Vec<Val>>,
    by_key: HashMap<Key, Vec<usize>>,
}

/// The terminal state and delivered-row count of a database row stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamResult {
    pub state: &'static str,
    pub count: u64,
}

pub const STREAM_EXHAUSTED: &str = "exhausted";
pub const STREAM_STOPPED: &str = "stopped";

impl Rows {
    pub fn len(&self) -> usize {
        self.cells.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    /// Moves the main step's rows out for assembly.
    pub fn take_cells(&mut self) -> Vec<Cells> {
        std::mem::take(&mut self.cells)
    }

    pub fn reverse_main(&mut self) {
        self.cells.reverse();
    }

    pub fn keyset_cursors(&mut self, order: &[ir::Order]) -> Result<(String, String)> {
        if self.cells.is_empty() {
            return Ok((String::new(), String::new()));
        }
        let values = |cell: &mut Cells| -> Result<Vec<Val>> {
            order
                .iter()
                .map(|item| {
                    let column = self
                        .assemble
                        .columns
                        .iter()
                        .find(|meta| meta.column == item.column)
                        .ok_or_else(|| Error::Engine {
                            code: crate::codes::CURSOR_INVALID.into(),
                            msg: format!("keyset order column is not projected: {}", item.column),
                        })?;
                    cell.val(column.index)
                })
                .collect()
        };
        let last_index = self.cells.len() - 1;
        let first = values(&mut self.cells[0])?;
        let last = values(&mut self.cells[last_index])?;
        Ok((
            crate::keyset::encode(order, &last)?,
            crate::keyset::encode(order, &first)?,
        ))
    }

    /// The main step's rows as positional rows (every row is `Cells::Pos` when the plan
    /// has relation steps).
    fn positional(&self) -> impl Iterator<Item = &[Val]> {
        self.cells.iter().filter_map(|c| match c {
            Cells::Pos(v) => Some(v.as_slice()),
            Cells::Raw(_) => None,
        })
    }

    /// The rows of relation child `ch` that belong to one parent row. Empty when the
    /// parent's value is null, when the step was skipped, or when the parent fails `if_parent`.
    pub fn related(&self, ch: &Child, parent: &mut impl Src) -> Result<Vec<&[Val]>> {
        let Some(sr) = self.steps.get(&ch.step) else {
            return Ok(Vec::new());
        };
        let st = &self.plan.steps[ch.step as usize];
        if let Some(ifp) = st.parent.as_ref().and_then(|p| p.if_parent.as_ref()) {
            if !same_scalar(&parent.val(ifp.index)?, &self.params[ifp.param]) {
                return Ok(Vec::new());
            }
        }
        let mut values = Vec::with_capacity(ch.parent_keys.len());
        for reference in &ch.parent_keys {
            values.push(parent.val(reference.index)?);
        }
        let Some(key) = Key::of_row(
            &values,
            &ch.parent_keys
                .iter()
                .enumerate()
                .map(|(index, reference)| crate::plan::KeyRef {
                    column: reference.column.clone(),
                    index,
                })
                .collect::<Vec<_>>(),
        ) else {
            return Ok(Vec::new());
        };
        Ok(match sr.by_key.get(&key) {
            Some(idxs) => idxs.iter().map(|&i| sr.data[i].as_slice()).collect(),
            None => Vec::new(),
        })
    }

    /// The assembly of the step a relation child's rows come from.
    pub fn step_assemble(&self, ch: &Child) -> &Arc<Assemble> {
        self.plan.steps[ch.step as usize]
            .assemble
            .as_ref()
            .expect("relation step has an assemble")
    }
}

/// Compares a row value with a bound parameter regardless of representation
/// (bool vs int, driver width): both are reduced to the same canonical text.
pub fn same_scalar(v: &Val, p: &Param) -> bool {
    let a = match v {
        Val::Null => return matches!(p, Param::Null),
        Val::Bool(b) => (*b as i64).to_string(),
        Val::I64(x) => x.to_string(),
        Val::F64(x) => x.to_string(),
        Val::Str(s) => s.clone(),
        Val::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
        Val::DateTime(t) => t.format("%Y-%m-%d %H:%M:%S%.6f").to_string(),
        Val::Date(d) => d.to_string(),
        Val::Json(j) => j.to_string(),
    };
    let b = match p {
        Param::Null => return false,
        Param::Bool(b) => (*b as i64).to_string(),
        Param::I64(x) => x.to_string(),
        Param::F64(x) => x.to_string(),
        Param::Str(s) => s.clone(),
        Param::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
        Param::DateTime(t) => t.format("%Y-%m-%d %H:%M:%S%.6f").to_string(),
        Param::Date(d) => d.to_string(),
        Param::Point(p) => format!("{},{}", p.0, p.1),
    };
    a == b
}

/// Distinct non-null values a relation step binds, first-seen order, from the
/// parent rows that pass `if_parent`.
fn parent_values<'a>(
    pr: &ParentRef,
    parents: impl Iterator<Item = &'a [Val]>,
    params: &[Param],
) -> Vec<Param> {
    let mut seen: std::collections::HashSet<Key> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for row in parents {
        if let Some(ifp) = &pr.if_parent {
            if !same_scalar(&row[ifp.index], &params[ifp.param]) {
                continue;
            }
        }
        let Some(key) = Key::of_row(row, &pr.keys) else {
            continue;
        };
        if seen.insert(key) {
            for reference in &pr.keys {
                let v = &row[reference.index];
                out.push(match v {
                    Val::I64(x) => Param::I64(*x),
                    Val::Str(s) => Param::Str(s.clone()),
                    Val::Bytes(b) => Param::Bytes(b.clone()),
                    Val::Bool(b) => Param::Bool(*b),
                    Val::F64(x) => Param::F64(*x),
                    Val::DateTime(t) => Param::DateTime(*t),
                    Val::Date(d) => Param::Date(*d),
                    Val::Json(j) => Param::Str(j.to_string()),
                    Val::Null => Param::Null,
                });
            }
        }
    }
    out
}

/// Rewrites the step's single `parent` placeholder into n placeholders. n is
/// rounded up to a power of two (values padded by repetition) so the prepared
/// statement cache holds one statement per size class. On PostgreSQL the plan has one
/// `$k` per slot in slot order: the parent slot becomes n placeholders and every later
/// number shifts by n-1 (docs/dialects.md).
fn expand_in(st: &Step, mut vals: Vec<Param>, numbered: bool) -> (String, Vec<Param>) {
    let width = st.parent.as_ref().map(|p| p.keys.len()).unwrap_or(0);
    assert!(
        width > 0 && vals.len() % width == 0,
        "invalid relation parent key values"
    );
    let tuples = vals.len() / width;
    let mut n = 1;
    while n < tuples {
        n <<= 1;
    }
    let last = vals[(tuples - 1) * width..tuples * width].to_vec();
    while vals.len() < n * width {
        vals.extend(last.iter().cloned());
    }
    let mut sql = String::with_capacity(st.sql.len() + 4 * n);
    if numbered {
        let parent = st
            .bind_slots
            .iter()
            .position(|b| b.from == "parent")
            .map(|i| i + 1)
            .unwrap_or(0);
        let bytes = st.sql.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] != b'$' {
                // copy one UTF-8 scalar (identifiers may carry any text)
                let ch = st.sql[i..].chars().next().unwrap();
                sql.push(ch);
                i += ch.len_utf8();
                continue;
            }
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            let k: usize = st.sql[i + 1..j].parse().unwrap_or(0);
            if k == parent {
                for m in 0..n * width {
                    if m > 0 {
                        if width > 1 && m % width == 0 {
                            sql.push_str("), (");
                        } else {
                            sql.push_str(", ");
                        }
                    }
                    sql.push_str(&format!("${}", k + m));
                }
            } else if k > parent {
                sql.push_str(&format!("${}", k + n * width - 1));
            } else {
                sql.push_str(&st.sql[i..j]);
            }
            i = j;
        }
        return (sql, vals);
    }
    let mut slot = 0;
    for c in st.sql.chars() {
        if c != '?' {
            sql.push(c);
            continue;
        }
        if st.bind_slots[slot].from == "parent" {
            sql.push('?');
            for m in 1..n * width {
                if width > 1 && m % width == 0 {
                    sql.push_str("), (?");
                } else {
                    sql.push_str(", ?");
                }
            }
        } else {
            sql.push('?');
        }
        slot += 1;
    }
    (sql, vals)
}

/// The value a `param` slot binds: the request parameter, transformed when the slot says so.
fn param_arg(b: &BindSlot, params: &[Param]) -> Result<Param> {
    let v = &params[b.param];
    if b.transform.is_empty() {
        return Ok(v.clone());
    }
    let Param::Str(s) = v else {
        return Err(Error::Config(format!(
            "transform {} needs a string",
            b.transform
        )));
    };
    Ok(Param::Str(transform(&b.transform, s)))
}

/// The hook's view of the binds: `secret` slots masked, everything else as bound.
fn masked(st: &Step, args: &[Param], n_parent: usize) -> Vec<Param> {
    let mut out = Vec::with_capacity(args.len());
    let mut i = 0;
    for b in &st.bind_slots {
        match b.from.as_str() {
            "parent" => {
                out.extend_from_slice(&args[i..i + n_parent]);
                i += n_parent;
            }
            "secret" => {
                out.push(Param::Str(SECRET_MASK.into()));
                i += 1;
            }
            "now" => {
                out.push(Param::Str(NOW_MASK.into()));
                i += 1;
            }
            _ => {
                out.push(args[i].clone());
                i += 1;
            }
        }
    }
    out
}

/// Finds the match column of a relation step from the child spec that references it.
fn child_keys(plan: &Plan, id: u32) -> Vec<crate::plan::KeyRef> {
    fn find(a: &Assemble, id: u32) -> Option<Vec<crate::plan::KeyRef>> {
        for ch in &a.children {
            if ch.kind != "join" && ch.step == id {
                return Some(ch.child_keys.clone());
            }
            if let Some(ja) = &ch.assemble {
                if let Some(i) = find(ja, id) {
                    return Some(i);
                }
            }
        }
        None
    }
    plan.steps
        .iter()
        .filter_map(|s| s.assemble.as_deref())
        .find_map(|a| find(a, id))
        .expect("relation step without a child spec")
}

impl Db {
    /// Connects the pool. The driver of `opts` must be the dialect the engine compiles for
    /// (docs/dialects.md): the plans are dialect-specific text.
    pub async fn connect(
        opts: ConnectOptions,
        max_connections: u32,
        engine: Arc<Engine>,
        cfg: Config,
    ) -> Result<Db> {
        let compiler: Arc<dyn PlanCompiler> = Arc::new(WasmPlanCompiler {
            engine: engine.clone(),
        });
        Self::connect_with_plan_compiler(opts, max_connections, engine, compiler, cfg).await
    }

    /// Connects the pool and compiles every plan-cache miss through the typed compiler transport.
    pub async fn connect_with_compiler(
        opts: ConnectOptions,
        max_connections: u32,
        engine: Arc<Engine>,
        compiler: Arc<dyn CompilerTransport>,
        cfg: Config,
    ) -> Result<Db> {
        let compiler: Arc<dyn PlanCompiler> = Arc::new(TransportPlanCompiler {
            transport: compiler,
        });
        Self::connect_with_plan_compiler(opts, max_connections, engine, compiler, cfg).await
    }

    async fn connect_with_plan_compiler(
        opts: ConnectOptions,
        max_connections: u32,
        engine: Arc<Engine>,
        compiler: Arc<dyn PlanCompiler>,
        cfg: Config,
    ) -> Result<Db> {
        if cfg.plan_cache_size == 0 || cfg.statement_cache_size == 0 {
            return Err(Error::Config("cache sizes must be positive".into()));
        }
        let metadata = compiler.metadata().await?;
        if metadata.schema_hash != engine.schema_hash {
            return Err(Error::Engine {
                code: crate::codes::SCHEMA_HASH_MISMATCH.into(),
                msg: format!(
                    "client schema {} but compiler loaded {}",
                    engine.schema_hash, metadata.schema_hash
                ),
            });
        }
        if metadata.dialect != opts.driver() {
            return Err(Error::Config(format!(
                "driver {} but the compiler uses {}",
                opts.driver(),
                metadata.dialect
            )));
        }
        if metadata.ir_version != 1 {
            return Err(Error::Engine {
                code: crate::codes::VERSION_MISMATCH.into(),
                msg: format!(
                    "client IR version 1 but compiler uses {}",
                    metadata.ir_version
                ),
            });
        }
        let pool = match opts {
            ConnectOptions::MySql(o) => Pool::MySql(
                MySqlPoolOptions::new()
                    .max_connections(max_connections)
                    .connect_with(o.statement_cache_capacity(cfg.statement_cache_size))
                    .await?,
            ),
            ConnectOptions::Postgres(o) => Pool::Postgres(
                PgPoolOptions::new()
                    .max_connections(max_connections)
                    .connect_with(o.statement_cache_capacity(cfg.statement_cache_size))
                    .await?,
            ),
            ConnectOptions::Sqlite(o) => Pool::Sqlite(
                SqlitePoolOptions::new()
                    .max_connections(max_connections)
                    .connect_with(o.statement_cache_capacity(cfg.statement_cache_size))
                    .await?,
            ),
        };
        Ok(Db {
            pool,
            engine,
            compiler,
            cfg: Arc::new(cfg),
            plans: Arc::new(Mutex::new(HashMap::new())),
            plan_order: Arc::new(Mutex::new(VecDeque::new())),
            pg_types: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// The database this Db talks to (mysql | postgres | sqlite).
    pub fn driver(&self) -> &'static str {
        match &self.pool {
            Pool::MySql(_) => "mysql",
            Pool::Postgres(_) => "postgres",
            Pool::Sqlite(_) => "sqlite",
        }
    }

    /// Compile (or fetch from cache) the plan for the request's shape. The cache key is
    /// FNV-1a 64 of the IR bytes (`Req::shape_key`), computed without allocating them.
    pub async fn plan(&self, req: &mut Req) -> Result<Arc<Plan>> {
        if let Some(e) = &req.err {
            return Err(e.error());
        }
        if req.ir.schema_hash != self.engine.schema_hash {
            return Err(Error::Engine {
                code: crate::codes::SCHEMA_HASH_MISMATCH.into(),
                msg: format!(
                    "request schema {} but client schema is {}",
                    req.ir.schema_hash, self.engine.schema_hash
                ),
            });
        }
        let key = req.shape_key();
        if let Some(p) = self.plans.lock().unwrap().get(&key) {
            return Ok(p.clone());
        }
        req.ir.n_params = req.params.len();
        let mut plan = self.compiler.compile(&req.ir).await?;
        for st in &mut plan.steps {
            st.plan_id = key;
        }
        let plan = Arc::new(plan);
        let mut plans = self.plans.lock().unwrap();
        if !plans.contains_key(&key) {
            plans.insert(key, plan.clone());
            let mut order = self.plan_order.lock().unwrap();
            order.push_back(key);
            while order.len() > self.cfg.plan_cache_size {
                if let Some(oldest) = order.pop_front() {
                    plans.remove(&oldest);
                }
            }
        }
        Ok(plan)
    }

    /// Validates and registers a plan emitted by `ormgen precompile`. The
    /// request binds the bundle to one exact shape; later plan() calls use the
    /// registered plan without contacting the compiler.
    pub fn load_plan_bundle(&self, bundle: &[u8], req: &mut Req) -> Result<()> {
        if let Some(e) = &req.err {
            return Err(e.error());
        }
        let envelope: serde_json::Value = serde_json::from_slice(bundle)
            .map_err(|e| Error::Config(format!("precompiled plan is invalid JSON: {e}")))?;
        let version = envelope
            .get("version")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        if version != 1 {
            return Err(Error::Engine {
                code: crate::codes::VERSION_MISMATCH.into(),
                msg: format!("precompiled plan version {version} is not supported"),
            });
        }
        let schema = envelope
            .get("schema_hash")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if schema != self.engine.schema_hash {
            return Err(Error::Engine {
                code: crate::codes::SCHEMA_HASH_MISMATCH.into(),
                msg: format!(
                    "precompiled plan schema {schema} but client schema is {}",
                    self.engine.schema_hash
                ),
            });
        }
        let dialect = envelope
            .get("dialect")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if dialect != self.driver() {
            return Err(Error::Config(format!(
                "precompiled plan dialect {dialect} but database driver is {}",
                self.driver()
            )));
        }
        let request_hash = envelope
            .get("request_sha256")
            .and_then(serde_json::Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| Error::Config("precompiled plan requires request_sha256".into()))?;
        req.ir.n_params = req.params.len();
        let request_value = serde_json::to_value(&req.ir)
            .map_err(|e| Error::Config(format!("request JSON: {e}")))?;
        let canonical = canonical_json(request_value);
        use sha2::{Digest, Sha256};
        let got = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&canonical)
                    .map_err(|e| Error::Config(format!("canonical request JSON: {e}")))?
            )
        );
        if request_hash != got {
            return Err(Error::Config(format!(
                "precompiled plan request hash {request_hash} does not match request shape {got}"
            )));
        }
        let raw_plan = envelope
            .get("plan")
            .ok_or_else(|| Error::Config("precompiled plan requires plan".into()))?;
        let mut plan: Plan = serde_json::from_value(raw_plan.clone())
            .map_err(|e| Error::Config(format!("precompiled plan body is invalid: {e}")))?;
        if plan.schema_hash != schema || plan.kind != req.ir.kind || plan.steps.is_empty() {
            return Err(Error::Config(
                "precompiled plan body does not match its envelope or request".into(),
            ));
        }
        let key = req.shape_key();
        for step in &mut plan.steps {
            step.plan_id = key;
        }
        let plan = Arc::new(plan);
        let mut plans = self.plans.lock().unwrap();
        if !plans.contains_key(&key) {
            plans.insert(key, plan);
            let mut order = self.plan_order.lock().unwrap();
            order.push_back(key);
            while order.len() > self.cfg.plan_cache_size {
                if let Some(oldest) = order.pop_front() {
                    plans.remove(&oldest);
                }
            }
        }
        Ok(())
    }

    /// Closes the pool and clears compiled plans. Calling it more than once is safe.
    pub async fn close(&self) {
        self.plans.lock().unwrap().clear();
        self.plan_order.lock().unwrap().clear();
        match &self.pool {
            Pool::MySql(pool) => pool.close().await,
            Pool::Postgres(pool) => pool.close().await,
            Pool::Sqlite(pool) => pool.close().await,
        }
    }

    /// Resolves a step's bind slots: params (host aes/hex/ip stages applied where the slot
    /// says so), the secret, the parent values, and `now` (UTC microsecond text). On SQLite
    /// every datetime binds as canonical text.
    fn args(&self, st: &Step, params: &[Param], parent_vals: &[Param]) -> Result<Vec<Param>> {
        let mut out = Vec::with_capacity(st.bind_slots.len() + parent_vals.len());
        for b in &st.bind_slots {
            match b.from.as_str() {
                "parent" => out.extend(parent_vals.iter().cloned()),
                "param" => {
                    let mut v = param_arg(b, params)?;
                    if b.col_type == "point" {
                        v = match v {
                            Param::Null => Param::Null,
                            Param::Point(point) => {
                                Param::Str(if matches!(&self.pool, Pool::Postgres(_)) {
                                    crate::value::postgres_point_text(point)?
                                } else {
                                    crate::point_text(point)?
                                })
                            }
                            Param::Str(text) => {
                                let point = crate::parse_point(&text)?;
                                Param::Str(if matches!(&self.pool, Pool::Postgres(_)) {
                                    crate::value::postgres_point_text(point)?
                                } else {
                                    crate::point_text(point)?
                                })
                            }
                            other => {
                                return Err(Error::Config(format!(
                                    "point parameter requires two coordinates, received {other:?}"
                                )))
                            }
                        };
                    }
                    out.push(if b.host_styles.is_empty() {
                        v
                    } else if b.host_styles.iter().any(|s| s == "blind_index") {
                        if b.host_styles.len() != 1 {
                            return Err(Error::Config(
                                "blind_index must be the only host style".into(),
                            ));
                        }
                        if matches!(v, Param::Null) {
                            Param::Null
                        } else {
                            Param::Str(crate::codec::blind_index(&v, &self.cfg.blind_index_key)?)
                        }
                    } else {
                        crate::codec::host_encode(&v, &b.host_styles, &self.cfg.aes_key)?
                    });
                }
                "secret" => match b.name.as_str() {
                    "aes" if !self.cfg.aes_key.is_empty() => {
                        out.push(Param::Str(self.cfg.aes_key.clone()))
                    }
                    _ => return Err(Error::Config(format!("secret {} not configured", b.name))),
                },
                "config" => match b.name.as_str() {
                    "aes_version" if self.cfg.aes_version > 0 => {
                        out.push(Param::I64(self.cfg.aes_version as i64))
                    }
                    _ => {
                        return Err(Error::Config(format!(
                            "config value {} not configured",
                            b.name
                        )))
                    }
                },
                "now" => out.push(Param::Str(
                    chrono::Utc::now()
                        .naive_utc()
                        .format(SQLITE_DATETIME)
                        .to_string(),
                )),
                other => return Err(Error::Config(format!("bind from {other}"))),
            }
        }
        if matches!(self.pool, Pool::Sqlite(_)) {
            for v in &mut out {
                if let Param::DateTime(t) = v {
                    *v = Param::Str(t.format(SQLITE_DATETIME).to_string());
                }
            }
        }
        Ok(out)
    }

    fn emit(
        &self,
        st: &Step,
        sql: &str,
        args: &[Param],
        n_parent: usize,
        start: std::time::Instant,
        err: Option<&Error>,
    ) {
        if let Some(h) = &self.cfg.on_query {
            let d = start.elapsed();
            if st
                .bind_slots
                .iter()
                .any(|b| b.from == "secret" || b.from == "now")
            {
                h(sql, &masked(st, args, n_parent), d, st.plan_id, err);
            } else {
                h(sql, args, d, st.plan_id, err);
            }
        }
    }

    /// PostgreSQL: the parameter types the server inferred for `sql`, prepared once per
    /// statement text (on any pool connection) and cached for every bind that follows.
    async fn pg_types_pool(&self, pool: &PgPool, sql: &str) -> Result<Arc<[PgTypeInfo]>> {
        if let Some(t) = self.pg_types.lock().unwrap().get(sql) {
            return Ok(t.clone());
        }
        let mut conn = pool.acquire().await?;
        let t = pg_describe(&mut *conn, sql).await?;
        self.pg_types
            .lock()
            .unwrap()
            .insert(sql.to_owned(), t.clone());
        Ok(t)
    }

    /// Same, prepared on a transaction's own connection.
    async fn pg_types_conn(
        &self,
        conn: &mut sqlx::PgConnection,
        sql: &str,
    ) -> Result<Arc<[PgTypeInfo]>> {
        if let Some(t) = self.pg_types.lock().unwrap().get(sql) {
            return Ok(t.clone());
        }
        let t = pg_describe(conn, sql).await?;
        self.pg_types
            .lock()
            .unwrap()
            .insert(sql.to_owned(), t.clone());
        Ok(t)
    }

    async fn begin(&self, options: TransactionOptions) -> Result<TxInner> {
        let level = options.isolation.sql_name();
        Ok(match &self.pool {
            Pool::MySql(p) => {
                // `Pool::begin_with` can only execute the statement that starts the
                // transaction. MySQL requires SET TRANSACTION to run immediately
                // before START TRANSACTION, so acquire and retain the same connection.
                let mut conn = p.acquire().await?;
                if let Some(level) = level {
                    let statement = format!("SET TRANSACTION ISOLATION LEVEL {level}");
                    sqlx::raw_sql(sqlx::AssertSqlSafe(statement).into_sql_str())
                        .execute(&mut *conn)
                        .await?;
                }
                let statement = if options.read_only {
                    "START TRANSACTION READ ONLY"
                } else {
                    "START TRANSACTION"
                };
                sqlx::raw_sql(statement).execute(&mut *conn).await?;
                TxInner::MySql(MySqlOwnedTx { conn: Some(conn) })
            }
            Pool::Postgres(p) => {
                let statement =
                    if options.isolation == IsolationLevel::Default && !options.read_only {
                        "BEGIN".to_owned()
                    } else {
                        let mut statement = String::from("BEGIN");
                        if let Some(level) = level {
                            statement.push_str(" ISOLATION LEVEL ");
                            statement.push_str(level);
                        }
                        if options.read_only {
                            statement.push_str(" READ ONLY");
                        }
                        statement
                    };
                TxInner::Postgres(
                    p.begin_with(sqlx::AssertSqlSafe(statement).into_sql_str())
                        .await?,
                )
            }
            Pool::Sqlite(p) => {
                if options.isolation != IsolationLevel::Default || options.read_only {
                    return Err(Error::Config(
                        "sqlite does not support transaction isolation or read-only mode".into(),
                    ));
                }
                TxInner::Sqlite(p.begin().await?)
            }
        })
    }

    /// Run `f` once in a transaction. An error rolls back the transaction.
    pub async fn transaction<T, F, Fut>(&self, f: F) -> Result<T>
    where
        F: Fn(Tx) -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        self.transaction_with_options(f, TransactionOptions::default())
            .await
    }

    /// Run `f` with an explicit deadlock retry policy.
    pub async fn transaction_with_options<T, F, Fut>(
        &self,
        f: F,
        options: TransactionOptions,
    ) -> Result<T>
    where
        F: Fn(Tx) -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        let attempts = if options.retry_deadlocks {
            options.max_attempts.max(1)
        } else {
            1
        };
        let mut last = None;
        for attempt in 0..attempts {
            let tx = Tx {
                inner: Arc::new(tokio::sync::Mutex::new(Some(self.begin(options).await?))),
                db: self.clone(),
                finished: Arc::new(AtomicBool::new(false)),
            };
            let _scope = TxScope(tx.clone());
            match f(tx.clone()).await {
                Ok(v) => {
                    tx.commit().await?;
                    return Ok(v);
                }
                Err(e) => {
                    tx.rollback().await;
                    if !options.retry_deadlocks || !e.is_deadlock() {
                        return Err(e);
                    }
                    last = Some(e);
                    let jitter = rand::random::<u64>() % 20;
                    tokio::time::sleep(std::time::Duration::from_millis(
                        (50u64 << attempt) + jitter,
                    ))
                    .await;
                }
            }
        }
        Err(last.unwrap())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IsolationLevel {
    Default,
    ReadUncommitted,
    ReadCommitted,
    RepeatableRead,
    Serializable,
}

impl IsolationLevel {
    fn sql_name(self) -> Option<&'static str> {
        Some(match self {
            Self::Default => return None,
            Self::ReadUncommitted => "READ UNCOMMITTED",
            Self::ReadCommitted => "READ COMMITTED",
            Self::RepeatableRead => "REPEATABLE READ",
            Self::Serializable => "SERIALIZABLE",
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct TransactionOptions {
    pub retry_deadlocks: bool,
    pub max_attempts: u32,
    pub isolation: IsolationLevel,
    pub read_only: bool,
}

impl Default for TransactionOptions {
    fn default() -> Self {
        Self {
            retry_deadlocks: false,
            max_attempts: 3,
            isolation: IsolationLevel::Default,
            read_only: false,
        }
    }
}

/// Prepares `sql` with no declared parameter types so the server infers them, and returns them.
async fn pg_describe<'e, E: Executor<'e, Database = Postgres>>(
    e: E,
    sql: &str,
) -> Result<Arc<[PgTypeInfo]>> {
    let stmt = e
        .prepare(sqlx::AssertSqlSafe(sql.to_owned()).into_sql_str())
        .await?;
    match stmt.parameters() {
        Some(sqlx::Either::Left(types)) => Ok(Arc::from(types.to_vec())),
        _ => Err(Error::internal(
            "postgres did not describe the statement's parameters",
        )),
    }
}

/// The transaction of one pool.
enum TxInner {
    MySql(MySqlOwnedTx),
    Postgres(sqlx::Transaction<'static, Postgres>),
    Sqlite(sqlx::Transaction<'static, Sqlite>),
}

/// A MySQL transaction whose pool connection is retained after the explicit
/// `SET TRANSACTION` and `START TRANSACTION` statements.
struct MySqlOwnedTx {
    conn: Option<sqlx::pool::PoolConnection<MySql>>,
}

impl MySqlOwnedTx {
    async fn commit(mut self) -> sqlx::Result<()> {
        let mut conn = self
            .conn
            .take()
            .expect("active MySQL transaction connection");
        sqlx::raw_sql("COMMIT").execute(&mut *conn).await?;
        Ok(())
    }

    async fn rollback(mut self) -> sqlx::Result<()> {
        let mut conn = self
            .conn
            .take()
            .expect("active MySQL transaction connection");
        sqlx::raw_sql("ROLLBACK").execute(&mut *conn).await?;
        Ok(())
    }
}

impl Drop for MySqlOwnedTx {
    fn drop(&mut self) {
        let Some(mut conn) = self.conn.take() else {
            return;
        };
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = sqlx::raw_sql("ROLLBACK").execute(&mut *conn).await;
            });
        }
    }
}

/// A transaction handle: cheap to clone, so closures can `async move` it.
#[derive(Clone)]
pub struct Tx {
    inner: Arc<tokio::sync::Mutex<Option<TxInner>>>,
    db: Db,
    finished: Arc<AtomicBool>,
}

// The callback future may be dropped or panic while rows still retain a Tx.
// Invalidate those handles and release the sqlx transaction on every exit path.
struct TxScope(Tx);

impl Drop for TxScope {
    fn drop(&mut self) {
        self.0.finished.store(true, Ordering::Release);
        if let Ok(mut inner) = self.0.inner.try_lock() {
            inner.take(); // sqlx queues rollback when its transaction is dropped.
        } else {
            let tx = self.0.clone();
            tokio::spawn(async move {
                tx.rollback().await;
            });
        }
    }
}

impl Tx {
    pub(crate) fn assert_active(&self) -> Result<()> {
        if self.finished.load(Ordering::Acquire) {
            return Err(Error::Config("transaction already finished".into()));
        }
        Ok(())
    }

    pub async fn savepoint(&self, name: &str) -> Result<()> {
        self.control("SAVEPOINT", name).await
    }
    pub async fn rollback_to(&self, name: &str) -> Result<()> {
        self.control("ROLLBACK TO SAVEPOINT", name).await
    }
    pub async fn release_savepoint(&self, name: &str) -> Result<()> {
        self.control("RELEASE SAVEPOINT", name).await
    }

    async fn control(&self, command: &str, name: &str) -> Result<()> {
        self.assert_active()?;
        if !valid_savepoint_name(name) {
            return Err(Error::Config(
                "savepoint name must match [A-Za-z_][A-Za-z0-9_]*".into(),
            ));
        }
        let sql = format!("{command} {name}");
        let mut guard = self.inner.lock().await;
        let tx = guard
            .as_mut()
            .ok_or_else(|| Error::Config("transaction already finished".into()))?;
        match tx {
            TxInner::MySql(t) => {
                sqlx::raw_sql(sqlx::AssertSqlSafe(sql.clone()).into_sql_str())
                    .execute(
                        &mut **t
                            .conn
                            .as_mut()
                            .expect("active MySQL transaction connection"),
                    )
                    .await?;
            }
            TxInner::Postgres(t) => {
                sqlx::query(sqlx::AssertSqlSafe(sql.clone()).into_sql_str())
                    .execute(&mut **t)
                    .await?;
            }
            TxInner::Sqlite(t) => {
                sqlx::query(sqlx::AssertSqlSafe(sql.clone()).into_sql_str())
                    .execute(&mut **t)
                    .await?;
            }
        }
        Ok(())
    }

    async fn commit(&self) -> Result<()> {
        self.finished.store(true, Ordering::Release);
        if let Some(t) = self.inner.lock().await.take() {
            match t {
                TxInner::MySql(t) => t.commit().await?,
                TxInner::Postgres(t) => t.commit().await?,
                TxInner::Sqlite(t) => t.commit().await?,
            }
        }
        Ok(())
    }

    async fn rollback(&self) {
        self.finished.store(true, Ordering::Release);
        if let Some(t) = self.inner.lock().await.take() {
            let _ = match t {
                TxInner::MySql(t) => t.rollback().await,
                TxInner::Postgres(t) => t.rollback().await,
                TxInner::Sqlite(t) => t.rollback().await,
            };
        }
    }
}

fn valid_savepoint_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c == '_' || c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

type MySqlQuery<'q> = sqlx::query::Query<'q, MySql, sqlx::mysql::MySqlArguments>;
type PgQuery<'q> = sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>;
type SqliteQuery<'q> = sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments>;

fn bind_mysql<'q>(q: MySqlQuery<'q>, p: &'q Param) -> MySqlQuery<'q> {
    match p {
        Param::Null => q.bind(Option::<i64>::None),
        Param::Bool(b) => q.bind(*b),
        Param::I64(x) => q.bind(*x),
        Param::F64(x) => q.bind(*x),
        Param::Str(s) => q.bind(s.as_str()),
        Param::Bytes(b) => q.bind(b.as_slice()),
        Param::DateTime(t) => q.bind(*t),
        Param::Date(d) => q.bind(*d),
        Param::Point(_) => unreachable!("point is converted to text before binding"),
    }
}

/// SQLite is dynamically typed: values bind as they are (datetimes already as text, see `args`).
fn bind_sqlite<'q>(q: SqliteQuery<'q>, p: &'q Param) -> SqliteQuery<'q> {
    match p {
        Param::Null => q.bind(Option::<i64>::None),
        Param::Bool(b) => q.bind(*b),
        Param::I64(x) => q.bind(*x),
        Param::F64(x) => q.bind(*x),
        Param::Str(s) => q.bind(s.as_str()),
        Param::Bytes(b) => q.bind(b.as_slice()),
        Param::DateTime(t) => q.bind(*t),
        Param::Date(d) => q.bind(*d),
        Param::Point(_) => unreachable!("point is converted to text before binding"),
    }
}

/// A datetime from the text forms an application binds (the same layouts Go's AsTime accepts).
fn parse_datetime(s: &str) -> Option<NaiveDateTime> {
    let s = s.trim();
    NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S"))
        .ok()
        .or_else(|| {
            chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|t| t.naive_utc())
        })
        .or_else(|| {
            NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .ok()
                .map(|d| d.and_hms_opt(0, 0, 0).unwrap())
        })
}

/// Binds one PostgreSQL parameter as the type the server inferred for its placeholder
/// (`ty`), converting the executor value the way pgx would; a value that cannot become
/// that type is CONFIG (the statement text and the value are named).
fn bind_pg<'q>(q: PgQuery<'q>, p: &'q Param, ty: &PgTypeInfo, i: usize) -> Result<PgQuery<'q>> {
    let name = ty.name();
    let bad = || {
        Error::Config(format!(
            "postgres parameter ${} is {name}: cannot bind {p:?}",
            i + 1
        ))
    };
    macro_rules! int {
        ($t:ty) => {
            match p {
                Param::Null => q.bind(Option::<$t>::None),
                Param::I64(x) => q.bind(<$t>::try_from(*x).map_err(|_| bad())?),
                Param::Bool(b) => q.bind(*b as $t),
                Param::Str(s) => q.bind(s.trim().parse::<$t>().map_err(|_| bad())?),
                Param::F64(x) if x.fract() == 0.0 => {
                    q.bind(<$t>::try_from(*x as i64).map_err(|_| bad())?)
                }
                _ => return Err(bad()),
            }
        };
    }
    macro_rules! float {
        ($t:ty) => {
            match p {
                Param::Null => q.bind(Option::<$t>::None),
                Param::F64(x) => q.bind(*x as $t),
                Param::I64(x) => q.bind(*x as $t),
                Param::Str(s) => q.bind(s.trim().parse::<$t>().map_err(|_| bad())?),
                _ => return Err(bad()),
            }
        };
    }
    Ok(match name {
        "INT2" => int!(i16),
        "INT4" => int!(i32),
        "INT8" => int!(i64),
        "FLOAT4" => float!(f32),
        "FLOAT8" => float!(f64),
        "NUMERIC" => match p {
            Param::Null => q.bind(Option::<rust_decimal::Decimal>::None),
            Param::F64(x) => q.bind(rust_decimal::Decimal::try_from(*x).map_err(|_| bad())?),
            Param::I64(x) => q.bind(rust_decimal::Decimal::from(*x)),
            Param::Str(s) => q.bind(rust_decimal::Decimal::from_str(s.trim()).map_err(|_| bad())?),
            _ => return Err(bad()),
        },
        "BOOL" => match p {
            Param::Null => q.bind(Option::<bool>::None),
            Param::Bool(b) => q.bind(*b),
            Param::I64(x) => q.bind(*x != 0),
            Param::Str(s) => q.bind(matches!(s.trim(), "1" | "true" | "t" | "TRUE")),
            _ => return Err(bad()),
        },
        "TEXT" | "VARCHAR" | "CHAR" | "\"CHAR\"" | "NAME" | "UNKNOWN" => match p {
            Param::Null => q.bind(Option::<&str>::None),
            Param::Str(s) => q.bind(s.as_str()),
            Param::I64(x) => q.bind(x.to_string()),
            Param::F64(x) => q.bind(x.to_string()),
            Param::Bool(b) => q.bind(b.to_string()),
            Param::DateTime(t) => q.bind(t.format("%Y-%m-%d %H:%M:%S%.6f").to_string()),
            Param::Date(d) => q.bind(d.to_string()),
            Param::Bytes(b) => q.bind(std::str::from_utf8(b).map_err(|_| bad())?),
            Param::Point(point) => q.bind(crate::point_text(*point)?),
        },
        "TIMESTAMP" => match p {
            Param::Null => q.bind(Option::<NaiveDateTime>::None),
            Param::DateTime(t) => q.bind(*t),
            Param::Date(d) => q.bind(d.and_hms_opt(0, 0, 0).unwrap()),
            Param::Str(s) => q.bind(parse_datetime(s).ok_or_else(bad)?),
            _ => return Err(bad()),
        },
        "TIMESTAMPTZ" => match p {
            Param::Null => q.bind(Option::<chrono::DateTime<chrono::Utc>>::None),
            Param::DateTime(t) => q.bind(t.and_utc()),
            Param::Date(d) => q.bind(d.and_hms_opt(0, 0, 0).unwrap().and_utc()),
            Param::Str(s) => q.bind(parse_datetime(s).ok_or_else(bad)?.and_utc()),
            _ => return Err(bad()),
        },
        "DATE" => match p {
            Param::Null => q.bind(Option::<NaiveDate>::None),
            Param::Date(d) => q.bind(*d),
            Param::DateTime(t) => q.bind(t.date()),
            Param::Str(s) => q.bind(parse_datetime(s).ok_or_else(bad)?.date()),
            _ => return Err(bad()),
        },
        "JSONB" | "JSON" => match p {
            Param::Null => q.bind(Option::<sqlx::types::Json<serde_json::Value>>::None),
            Param::Str(s) => q.bind(sqlx::types::Json(
                serde_json::value::RawValue::from_string(s.clone()).map_err(|_| bad())?,
            )),
            _ => return Err(bad()),
        },
        "BYTEA" => match p {
            Param::Null => q.bind(Option::<&[u8]>::None),
            Param::Bytes(b) => q.bind(b.as_slice()),
            Param::Str(s) => q.bind(s.as_bytes()),
            _ => return Err(bad()),
        },
        "INET" => match p {
            Param::Null => q.bind(Option::<std::net::IpAddr>::None),
            Param::Str(s) => q.bind(s.trim().parse::<std::net::IpAddr>().map_err(|_| bad())?),
            _ => return Err(bad()),
        },
        other => {
            return Err(Error::Config(format!(
                "postgres parameter ${} has type {other}, which the executor cannot bind",
                i + 1
            )))
        }
    })
}

async fn fetch_mysql<'e, E: Executor<'e, Database = MySql>>(
    sql: &str,
    args: &[Param],
    e: E,
) -> sqlx::Result<Vec<MySqlRow>> {
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for a in args {
        q = bind_mysql(q, a);
    }
    q.fetch_all(e).await
}

async fn stream_mysql<'e, E, F>(
    sql: &str,
    args: &[Param],
    e: E,
    visit: &mut F,
) -> Result<(u64, bool)>
where
    E: Executor<'e, Database = MySql>,
    F: FnMut(DriverRow) -> Result<bool>,
{
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for arg in args {
        query = bind_mysql(query, arg);
    }
    let mut rows = query.fetch(e);
    let mut count = 0;
    while let Some(row) = rows.try_next().await? {
        count += 1;
        if !visit(DriverRow::MySql(row))? {
            return Ok((count, false));
        }
    }
    Ok((count, true))
}

async fn exec_mysql<'e, E: Executor<'e, Database = MySql>>(
    sql: &str,
    args: &[Param],
    e: E,
) -> sqlx::Result<(u64, u64)> {
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for a in args {
        q = bind_mysql(q, a);
    }
    let r = q.execute(e).await?;
    Ok((r.last_insert_id(), r.rows_affected()))
}

fn pg_query<'q>(sql: &str, args: &'q [Param], types: &[PgTypeInfo]) -> Result<PgQuery<'q>> {
    if types.len() != args.len() {
        return Err(Error::internal(format!(
            "postgres described {} parameters, the plan binds {}",
            types.len(),
            args.len()
        )));
    }
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for (i, (a, ty)) in args.iter().zip(types).enumerate() {
        q = bind_pg(q, a, ty, i)?;
    }
    Ok(q)
}

async fn fetch_pg<'e, E: Executor<'e, Database = Postgres>>(
    sql: &str,
    args: &[Param],
    types: &[PgTypeInfo],
    e: E,
) -> Result<Vec<PgRow>> {
    Ok(pg_query(sql, args, types)?.fetch_all(e).await?)
}

async fn stream_pg<'e, E, F>(
    sql: &str,
    args: &[Param],
    types: &[PgTypeInfo],
    e: E,
    visit: &mut F,
) -> Result<(u64, bool)>
where
    E: Executor<'e, Database = Postgres>,
    F: FnMut(DriverRow) -> Result<bool>,
{
    let query = pg_query(sql, args, types)?;
    let mut rows = query.fetch(e);
    let mut count = 0;
    while let Some(row) = rows.try_next().await? {
        count += 1;
        if !visit(DriverRow::Postgres(row))? {
            return Ok((count, false));
        }
    }
    Ok((count, true))
}

async fn exec_pg<'e, E: Executor<'e, Database = Postgres>>(
    sql: &str,
    args: &[Param],
    types: &[PgTypeInfo],
    e: E,
) -> Result<(u64, u64)> {
    let r = pg_query(sql, args, types)?.execute(e).await?;
    Ok((0, r.rows_affected()))
}

async fn fetch_sqlite<'e, E: Executor<'e, Database = Sqlite>>(
    sql: &str,
    args: &[Param],
    e: E,
) -> sqlx::Result<Vec<SqliteRow>> {
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for a in args {
        q = bind_sqlite(q, a);
    }
    q.fetch_all(e).await
}

async fn stream_sqlite<'e, E, F>(
    sql: &str,
    args: &[Param],
    e: E,
    visit: &mut F,
) -> Result<(u64, bool)>
where
    E: Executor<'e, Database = Sqlite>,
    F: FnMut(DriverRow) -> Result<bool>,
{
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for arg in args {
        query = bind_sqlite(query, arg);
    }
    let mut rows = query.fetch(e);
    let mut count = 0;
    while let Some(row) = rows.try_next().await? {
        count += 1;
        if !visit(DriverRow::Sqlite(row))? {
            return Ok((count, false));
        }
    }
    Ok((count, true))
}

async fn exec_sqlite<'e, E: Executor<'e, Database = Sqlite>>(
    sql: &str,
    args: &[Param],
    e: E,
) -> sqlx::Result<(u64, u64)> {
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql));
    for a in args {
        q = bind_sqlite(q, a);
    }
    let r = q.execute(e).await?;
    Ok((r.last_insert_rowid() as u64, r.rows_affected()))
}

/// Where a statement runs: the pool (each statement on its own) or a transaction's connection.
enum Target<'a> {
    Pool(&'a Pool),
    Tx(&'a mut TxInner),
}

/// The statement text of a step: the plan's SQL as is, or with its `parent` placeholder expanded.
fn statement(st: &Step, parent_vals: Vec<Param>, numbered: bool) -> (Cow<'_, str>, Vec<Param>) {
    if parent_vals.is_empty() {
        (Cow::Borrowed(st.sql.as_str()), parent_vals)
    } else {
        let (sql, vals) = expand_in(st, parent_vals, numbered);
        (Cow::Owned(sql), vals)
    }
}

async fn run_query(
    db: &Db,
    target: Target<'_>,
    st: &Step,
    params: &[Param],
    parent_vals: Vec<Param>,
) -> Result<Vec<DriverRow>> {
    let (sql, parent_vals) = statement(st, parent_vals, matches!(db.pool, Pool::Postgres(_)));
    let args = db.args(st, params, &parent_vals)?;
    let start = std::time::Instant::now();
    let r: Result<Vec<DriverRow>> = match target {
        Target::Pool(Pool::MySql(p)) => fetch_mysql(&sql, &args, p)
            .await
            .map(|v| v.into_iter().map(DriverRow::MySql).collect())
            .map_err(Error::from),
        Target::Tx(TxInner::MySql(t)) => fetch_mysql(
            &sql,
            &args,
            &mut **t
                .conn
                .as_mut()
                .expect("active MySQL transaction connection"),
        )
        .await
        .map(|v| v.into_iter().map(DriverRow::MySql).collect())
        .map_err(Error::from),
        Target::Pool(Pool::Postgres(p)) => match db.pg_types_pool(p, &sql).await {
            Ok(types) => fetch_pg(&sql, &args, &types, p)
                .await
                .map(|v| v.into_iter().map(DriverRow::Postgres).collect()),
            Err(e) => Err(e),
        },
        Target::Tx(TxInner::Postgres(t)) => match db.pg_types_conn(&mut **t, &sql).await {
            Ok(types) => fetch_pg(&sql, &args, &types, &mut **t)
                .await
                .map(|v| v.into_iter().map(DriverRow::Postgres).collect()),
            Err(e) => Err(e),
        },
        Target::Pool(Pool::Sqlite(p)) => fetch_sqlite(&sql, &args, p)
            .await
            .map(|v| v.into_iter().map(DriverRow::Sqlite).collect())
            .map_err(Error::from),
        Target::Tx(TxInner::Sqlite(t)) => fetch_sqlite(&sql, &args, &mut **t)
            .await
            .map(|v| v.into_iter().map(DriverRow::Sqlite).collect())
            .map_err(Error::from),
    };
    db.emit(st, &sql, &args, parent_vals.len(), start, r.as_ref().err());
    r
}

async fn run_stream<F>(
    db: &Db,
    target: Target<'_>,
    st: &Step,
    params: &[Param],
    visit: &mut F,
) -> Result<(u64, bool)>
where
    F: FnMut(DriverRow) -> Result<bool>,
{
    let sql = st.sql.as_str();
    let args = db.args(st, params, &[])?;
    let start = std::time::Instant::now();
    let result = match target {
        Target::Pool(Pool::MySql(pool)) => stream_mysql(sql, &args, pool, visit).await,
        Target::Tx(TxInner::MySql(tx)) => {
            stream_mysql(
                sql,
                &args,
                &mut **tx
                    .conn
                    .as_mut()
                    .expect("active MySQL transaction connection"),
                visit,
            )
            .await
        }
        Target::Pool(Pool::Postgres(pool)) => {
            let types = db.pg_types_pool(pool, sql).await?;
            stream_pg(sql, &args, &types, pool, visit).await
        }
        Target::Tx(TxInner::Postgres(tx)) => {
            let types = db.pg_types_conn(&mut **tx, sql).await?;
            stream_pg(sql, &args, &types, &mut **tx, visit).await
        }
        Target::Pool(Pool::Sqlite(pool)) => stream_sqlite(sql, &args, pool, visit).await,
        Target::Tx(TxInner::Sqlite(tx)) => stream_sqlite(sql, &args, &mut **tx, visit).await,
    };
    db.emit(st, sql, &args, 0, start, result.as_ref().err());
    result
}

async fn run_execute(
    db: &Db,
    target: Target<'_>,
    st: &Step,
    params: &[Param],
) -> Result<(u64, u64)> {
    let args = db.args(st, params, &[])?;
    let sql = st.sql.as_str();
    let start = std::time::Instant::now();
    let r: Result<(u64, u64)> = match target {
        Target::Pool(Pool::MySql(p)) => exec_mysql(sql, &args, p).await.map_err(Error::from),
        Target::Tx(TxInner::MySql(t)) => exec_mysql(
            sql,
            &args,
            &mut **t
                .conn
                .as_mut()
                .expect("active MySQL transaction connection"),
        )
        .await
        .map_err(Error::from),
        Target::Pool(Pool::Postgres(p)) => match db.pg_types_pool(p, sql).await {
            Ok(types) => exec_pg(sql, &args, &types, p).await,
            Err(e) => Err(e),
        },
        Target::Tx(TxInner::Postgres(t)) => match db.pg_types_conn(&mut **t, sql).await {
            Ok(types) => exec_pg(sql, &args, &types, &mut **t).await,
            Err(e) => Err(e),
        },
        Target::Pool(Pool::Sqlite(p)) => exec_sqlite(sql, &args, p).await.map_err(Error::from),
        Target::Tx(TxInner::Sqlite(t)) => {
            exec_sqlite(sql, &args, &mut **t).await.map_err(Error::from)
        }
    };
    db.emit(st, sql, &args, 0, start, r.as_ref().err());
    r
}

/// The database or transaction selected by a query binding.
pub trait Exec: Sync {
    fn db(&self) -> &Db;
    /// The transaction this executor runs in; None for a `Db` (each statement on its own).
    fn tx(&self) -> Option<&Tx>;
    /// Runs a select step; `parent_vals` are the values for its `parent` slot (empty for the main step).
    fn query(
        &self,
        st: &Step,
        params: &[Param],
        parent_vals: Vec<Param>,
    ) -> impl Future<Output = Result<Vec<DriverRow>>> + Send;
    /// Runs a write step; returns (last insert id as the driver reports it, rows affected).
    fn execute(
        &self,
        st: &Step,
        params: &[Param],
    ) -> impl Future<Output = Result<(u64, u64)>> + Send;
}

impl Exec for Db {
    fn db(&self) -> &Db {
        self
    }

    fn tx(&self) -> Option<&Tx> {
        None
    }

    async fn query(
        &self,
        st: &Step,
        params: &[Param],
        parent_vals: Vec<Param>,
    ) -> Result<Vec<DriverRow>> {
        run_query(self, Target::Pool(&self.pool), st, params, parent_vals).await
    }

    async fn execute(&self, st: &Step, params: &[Param]) -> Result<(u64, u64)> {
        run_execute(self, Target::Pool(&self.pool), st, params).await
    }
}

impl Exec for Tx {
    fn db(&self) -> &Db {
        &self.db
    }

    fn tx(&self) -> Option<&Tx> {
        Some(self)
    }

    async fn query(
        &self,
        st: &Step,
        params: &[Param],
        parent_vals: Vec<Param>,
    ) -> Result<Vec<DriverRow>> {
        let mut guard = self.inner.lock().await;
        self.assert_active()?;
        let tx = guard
            .as_mut()
            .ok_or_else(|| Error::Config("transaction already finished".into()))?;
        run_query(&self.db, Target::Tx(tx), st, params, parent_vals).await
    }

    async fn execute(&self, st: &Step, params: &[Param]) -> Result<(u64, u64)> {
        let mut guard = self.inner.lock().await;
        self.assert_active()?;
        let tx = guard
            .as_mut()
            .ok_or_else(|| Error::Config("transaction already finished".into()))?;
        run_execute(&self.db, Target::Tx(tx), st, params).await
    }
}

/// Run the select plan of a request: the main step, then every relation step.
pub async fn select(ex: &impl Exec, req: &mut Req, kind: &str) -> Result<Rows> {
    req.ir.kind = kind.into();
    let plan = ex.db().plan(req).await?;
    run_plan(ex, plan, req).await
}

/// Visits independently owned rows from a single select cursor. Plans with
/// separate relation steps are rejected; SQL joins remain part of the root row.
pub async fn stream<F>(ex: &impl Exec, req: &mut Req, mut visit: F) -> Result<StreamResult>
where
    F: FnMut(Cells, &Rows) -> Result<bool>,
{
    req.ir.kind = "all".into();
    let plan = ex.db().plan(req).await?;
    if plan
        .steps
        .iter()
        .skip(1)
        .any(|step| step.role == "relation")
    {
        return Err(Error::Engine {
            code: crate::codes::IR_INVALID.into(),
            msg: "stream does not support separate relation steps; use a join or gets".into(),
        });
    }
    let step = &plan.steps[0];
    let assemble = step
        .assemble
        .clone()
        .ok_or_else(|| Error::internal("no assemble"))?;
    let context = Rows {
        binding: crate::binding::Binding::new(ex),
        assemble: assemble.clone(),
        cells: Vec::new(),
        plan: plan.clone(),
        steps: HashMap::new(),
        params: req.params.clone(),
    };
    let db = ex.db();
    let mysql = matches!(db.pool, Pool::MySql(_)) && !assemble_has_aes(&assemble);
    let mut decode = |raw: DriverRow| -> Result<bool> {
        let cells = if mysql {
            Cells::Raw(raw.into_mysql())
        } else {
            let mut data = vec![read_row(&raw, assemble.total_columns())?];
            decode_styled(&assemble, &mut data, &db.cfg.aes_keys)?;
            Cells::Pos(data.pop().expect("one stream row"))
        };
        visit(cells, &context)
    };
    let (count, exhausted) = if let Some(tx) = ex.tx() {
        let mut guard = tx.inner.lock().await;
        tx.assert_active()?;
        let target = guard
            .as_mut()
            .ok_or_else(|| Error::Config("transaction already finished".into()))?;
        run_stream(db, Target::Tx(target), step, &req.params, &mut decode).await?
    } else {
        run_stream(db, Target::Pool(&db.pool), step, &req.params, &mut decode).await?
    };
    Ok(StreamResult {
        state: if exhausted {
            STREAM_EXHAUSTED
        } else {
            STREAM_STOPPED
        },
        count,
    })
}

/// Driver rows as decoded positional rows: cells by column type, styled cells through their
/// host and codec stages.
fn positional(
    raw: &[DriverRow],
    asm: &Assemble,
    aes_keys: &BTreeMap<i32, String>,
) -> Result<Vec<Vec<Val>>> {
    let n = asm.total_columns();
    let mut data: Vec<Vec<Val>> = raw.iter().map(|r| read_row(r, n)).collect::<Result<_>>()?;
    decode_styled(asm, &mut data, aes_keys)?;
    Ok(data)
}

async fn run_plan(ex: &impl Exec, plan: Arc<Plan>, req: &mut Req) -> Result<Rows> {
    let db = ex.db();
    let st = &plan.steps[0];
    let asm = st
        .assemble
        .clone()
        .ok_or_else(|| Error::internal("no assemble"))?;
    let raw = ex.query(st, &req.params, Vec::new()).await?;
    let has_relations = plan.steps.iter().skip(1).any(|s| s.role == "relation");
    // Relation steps read parent values positionally and attach by key. Without them a MySQL
    // driver row goes straight to the generated struct; PostgreSQL/SQLite rows are decoded here.
    let cells: Vec<Cells> =
        if !has_relations && matches!(db.pool, Pool::MySql(_)) && !assemble_has_aes(&asm) {
            raw.into_iter()
                .map(|r| Cells::Raw(r.into_mysql()))
                .collect()
        } else {
            positional(&raw, &asm, &db.cfg.aes_keys)?
                .into_iter()
                .map(Cells::Pos)
                .collect()
        };
    let mut rows = Rows {
        binding: crate::binding::Binding::new(ex),
        assemble: asm,
        cells,
        plan: plan.clone(),
        steps: HashMap::new(),
        params: Vec::new(),
    };
    for st in plan.steps.iter().skip(1) {
        if st.role != "relation" {
            continue;
        }
        let pr = st.parent.as_ref().expect("relation step has a parent");
        let vals = if pr.step == 0 {
            parent_values(pr, rows.positional(), &req.params)
        } else {
            parent_values(
                pr,
                rows.steps[&pr.step].data.iter().map(Vec::as_slice),
                &req.params,
            )
        };
        let mut sr = StepRows {
            data: Vec::new(),
            by_key: HashMap::new(),
        };
        if !vals.is_empty() {
            let asm = st.assemble.as_ref().expect("relation step has an assemble");
            for chunk in relation_chunks(st, vals, db.driver())? {
                let raw = ex.query(st, &req.params, chunk).await?;
                sr.data.extend(positional(&raw, asm, &db.cfg.aes_keys)?);
            }
            let keys = child_keys(&plan, st.id);
            for (j, row) in sr.data.iter().enumerate() {
                if let Some(key) = Key::of_row(row, &keys) {
                    sr.by_key.entry(key).or_default().push(j);
                }
            }
        }
        rows.steps.insert(st.id, sr);
    }
    rows.params = req.params.clone();
    Ok(rows)
}

fn relation_chunks(st: &Step, vals: Vec<Param>, driver: &str) -> Result<Vec<Vec<Param>>> {
    let width = st
        .parent
        .as_ref()
        .map(|parent| parent.keys.len())
        .unwrap_or(0);
    if width == 0 || vals.len() % width != 0 {
        return Err(Error::Engine {
            code: crate::codes::IR_INVALID.into(),
            msg: format!("relation {} has invalid parent key values", st.id),
        });
    }
    let non_parent = st
        .bind_slots
        .iter()
        .filter(|bind| bind.from != "parent")
        .count();
    let limit: usize = if driver == "sqlite" { 999 } else { 65535 };
    let max_tuples = (limit.saturating_sub(non_parent)) / width;
    if max_tuples == 0 {
        return Err(Error::Engine {
            code: crate::codes::IR_INVALID.into(),
            msg: format!(
                "relation {} needs at least {} bind parameters but {} permits {}",
                st.id,
                non_parent + width,
                driver,
                limit
            ),
        });
    }
    let mut chunk_tuples = 1usize;
    while chunk_tuples.saturating_mul(2) <= max_tuples {
        chunk_tuples *= 2;
    }
    let tuples = vals.len() / width;
    let mut chunks = Vec::with_capacity((tuples + chunk_tuples - 1) / chunk_tuples);
    for start in (0..tuples).step_by(chunk_tuples) {
        let end = (start + chunk_tuples).min(tuples);
        chunks.push(vals[start * width..end * width].to_vec());
    }
    Ok(chunks)
}

fn assemble_has_aes(asm: &Assemble) -> bool {
    asm.columns
        .iter()
        .any(|c| c.styles.iter().any(|style| style == "aes"))
        || asm
            .children
            .iter()
            .filter_map(|child| child.assemble.as_deref())
            .any(assemble_has_aes)
}

/// The first cell of the first row (Null when there is no row).
fn first_cell(rows: &[DriverRow]) -> Result<Val> {
    match rows.first() {
        Some(r) => read_cell(r, 0),
        None => Ok(Val::Null),
    }
}

pub async fn scalar(ex: &impl Exec, req: &mut Req, kind: &str) -> Result<Val> {
    req.ir.kind = kind.into();
    let plan = ex.db().plan(req).await?;
    let rows = ex.query(&plan.steps[0], &req.params, Vec::new()).await?;
    first_cell(&rows)
}

/// Runs the request's raw statement (kind raw, step role raw, no assemble) and returns
/// its rows keyed by the driver's column names in column order; cells are decoded by
/// column type like any positional row (no codec, no assembly).
pub async fn raw(ex: &impl Exec, req: &mut Req) -> Result<Vec<indexmap::IndexMap<String, Val>>> {
    req.ir.kind = "raw".into();
    let plan = ex.db().plan(req).await?;
    let rows = ex.query(&plan.steps[0], &req.params, Vec::new()).await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let n = r.len();
        let vals = read_row(r, n)?;
        let mut m = indexmap::IndexMap::with_capacity(n);
        for (i, v) in vals.into_iter().enumerate() {
            m.insert(r.column_name(i).to_owned(), v);
        }
        out.push(m);
    }
    Ok(out)
}

pub async fn paginate(ex: &impl Exec, req: &mut Req) -> Result<(Rows, i64)> {
    req.ir.kind = "paginate".into();
    let plan = ex.db().plan(req).await?;
    let rows = run_plan(ex, plan.clone(), req).await?;
    let count = plan
        .steps
        .iter()
        .find(|s| s.role == "count")
        .expect("paginate plan has a count step");
    let cnt = ex.query(count, &rows.params, Vec::new()).await?;
    let total = first_cell(&cnt)?.as_i64();
    Ok((rows, total))
}

/// insert/update/delete. Returns (last_insert_id, affected). Optimistic updates
/// that match no row fail with OptimisticLock. On PostgreSQL/SQLite an insert's id comes
/// back as a row (`RETURNING pk`), not from the driver's last insert id.
pub async fn write(ex: &impl Exec, req: &mut Req, kind: &str) -> Result<(u64, u64)> {
    req.ir.kind = kind.into();
    let plan = ex.db().plan(req).await?;
    let st = &plan.steps[0];
    if kind == "insert" && st.sql.contains(" RETURNING ") {
        let rows = ex.query(st, &req.params, Vec::new()).await?;
        return Ok((first_cell(&rows)?.as_i64() as u64, 1));
    }
    let (id, affected) = ex.execute(st, &req.params).await?;
    if kind == "update" && req.ir.optimistic.is_some() && affected == 0 {
        return Err(Error::OptimisticLock);
    }
    Ok((id, affected))
}

/// Bounds one homogeneous batch while preserving one transaction boundary.
#[derive(Clone, Copy, Debug)]
pub struct BatchOptions {
    pub chunk_size: usize,
}

impl Default for BatchOptions {
    fn default() -> Self {
        Self { chunk_size: 1000 }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BatchResult {
    pub attempted: usize,
    pub affected: u64,
    pub inserted: u64,
}

async fn batch_write_target(
    ex: &impl Exec,
    requests: &mut [Req],
    kind: &str,
    options: BatchOptions,
) -> Result<BatchResult> {
    let mut result = BatchResult::default();
    for chunk in requests.chunks_mut(options.chunk_size.max(1)) {
        for request in chunk {
            result.attempted += 1;
            let (_, affected) = write(ex, request, kind).await?;
            if kind == "insert" {
                // MySQL reports 2 for an upsert that updates a duplicate
                // while PostgreSQL and SQLite report 1. Expose one per request.
                result.affected += 1;
                result.inserted += 1;
            } else {
                result.affected += affected;
            }
        }
    }
    Ok(result)
}

/// Executes typed generated requests in one transaction. A transaction
/// supplied by the caller is reused; a pool executor creates one transaction.
pub async fn batch_write(
    ex: &impl Exec,
    mut requests: Vec<Req>,
    kind: &str,
    options: BatchOptions,
) -> Result<BatchResult> {
    if !matches!(kind, "insert" | "update" | "delete") {
        return Err(Error::Config(format!(
            "batch kind {kind:?} is not supported"
        )));
    }
    if requests.is_empty() {
        return Ok(BatchResult::default());
    }
    if ex.tx().is_some() {
        return batch_write_target(ex, &mut requests, kind, options).await;
    }
    let kind = kind.to_owned();
    ex.db()
        .transaction(|tx| {
            let mut requests = requests.clone();
            let kind = kind.clone();
            async move { batch_write_target(&tx, &mut requests, &kind, options).await }
        })
        .await
}

/// The main statement of a query, rendered but not executed (`sql(&db)`).
#[derive(Debug, Clone, PartialEq)]
pub struct Sql {
    pub sql: String,
    /// `param` slots as their (transformed) values, `secret` slots as the string "$SECRET".
    pub binds: Vec<Param>,
    /// The plan-cache key of the statement's plan.
    pub plan_id: u64,
}

/// Compiles (or fetches) the plan for `kind` and returns its main step without executing.
pub async fn sql(ex: &impl Exec, req: &mut Req, kind: &str) -> Result<Sql> {
    req.ir.kind = kind.into();
    let plan = ex.db().plan(req).await?;
    let st = &plan.steps[0];
    let mut binds = Vec::with_capacity(st.bind_slots.len());
    for b in &st.bind_slots {
        match b.from.as_str() {
            "param" => binds.push(param_arg(b, &req.params)?),
            "secret" => binds.push(Param::Str(SECRET_MASK.into())),
            "config" => match b.name.as_str() {
                "aes_version" if ex.db().cfg.aes_version > 0 => {
                    binds.push(Param::I64(ex.db().cfg.aes_version as i64))
                }
                _ => {
                    return Err(Error::Config(format!(
                        "config value {} not configured",
                        b.name
                    )))
                }
            },
            "now" => binds.push(Param::Str(NOW_MASK.into())),
            other => return Err(Error::Config(format!("bind from {other}"))),
        }
    }
    Ok(Sql {
        sql: st.sql.clone(),
        binds,
        plan_id: st.plan_id,
    })
}

/// Whether a joined node's slice of the row is present (its first column is not NULL).
pub fn join_present(src: &mut impl Src, a: &Assemble) -> bool {
    !a.columns.is_empty() && !src.is_null(a.columns[0].index)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    struct BundleCompiler {
        schema_hash: String,
    }

    struct CountingPlanCompiler {
        schema_hash: String,
        calls: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl PlanCompiler for CountingPlanCompiler {
        async fn compile(&self, request: &ir::Request) -> Result<Plan> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(Plan {
                schema_hash: self.schema_hash.clone(),
                kind: request.kind.clone(),
                steps: vec![Step {
                    plan_id: 0,
                    id: 0,
                    role: "main".into(),
                    sql: request.kind.clone(),
                    bind_slots: Vec::new(),
                    assemble: None,
                    parent: None,
                }],
            })
        }

        async fn metadata(&self) -> Result<GetMetadataResponse> {
            Ok(GetMetadataResponse {
                schema_hash: self.schema_hash.clone(),
                dialect: "sqlite".into(),
                ir_version: 1,
            })
        }
    }

    #[async_trait::async_trait]
    impl CompilerTransport for BundleCompiler {
        async fn compile(
            &self,
            _request: crate::compiler_proto::CompileRequest,
        ) -> Result<crate::compiler_proto::Plan> {
            panic!("compiler must not be called after loading a plan bundle")
        }

        async fn metadata(&self) -> Result<GetMetadataResponse> {
            Ok(GetMetadataResponse {
                schema_hash: self.schema_hash.clone(),
                dialect: "sqlite".into(),
                ir_version: 1,
            })
        }
    }

    fn step(sql: &str, slots: &[&str]) -> Step {
        Step {
            plan_id: 0,
            id: 1,
            role: "relation".into(),
            sql: sql.into(),
            bind_slots: slots
                .iter()
                .map(|f| BindSlot {
                    from: f.to_string(),
                    param: 0,
                    transform: String::new(),
                    name: String::new(),
                    step: 0,
                    column: String::new(),
                    host_styles: Vec::new(),
                    col_type: String::new(),
                })
                .collect(),
            assemble: None,
            parent: Some(ParentRef {
                step: 0,
                keys: vec![crate::plan::KeyRef {
                    column: "seq".into(),
                    index: 0,
                }],
                if_parent: None,
            }),
        }
    }

    #[test]
    fn expand_in_renumbers_postgres_placeholders() {
        let st = step(
            r#"SELECT "a"."seq" FROM "t" AS "a" WHERE "a"."x" = $1 AND "a"."seq" IN ($2) AND "a"."y" > $3 ORDER BY $4"#,
            &["param", "parent", "param", "param"],
        );
        let vals = vec![Param::I64(1), Param::I64(2), Param::I64(3)];
        let (sql, padded) = expand_in(&st, vals, true);
        assert_eq!(
            sql,
            r#"SELECT "a"."seq" FROM "t" AS "a" WHERE "a"."x" = $1 AND "a"."seq" IN ($2, $3, $4, $5) AND "a"."y" > $6 ORDER BY $7"#
        );
        assert_eq!(
            padded,
            vec![Param::I64(1), Param::I64(2), Param::I64(3), Param::I64(3)]
        );
        let (sql, padded) = expand_in(&st, vec![Param::I64(9)], true);
        assert_eq!(
            sql,
            r#"SELECT "a"."seq" FROM "t" AS "a" WHERE "a"."x" = $1 AND "a"."seq" IN ($2) AND "a"."y" > $3 ORDER BY $4"#
        );
        assert_eq!(padded, vec![Param::I64(9)]);
    }

    #[test]
    fn expand_in_question_marks() {
        let st = step(
            "SELECT 1 FROM t WHERE x = ? AND seq IN (?) AND y > ?",
            &["param", "parent", "param"],
        );
        let (sql, padded) = expand_in(
            &st,
            vec![Param::I64(1), Param::I64(2), Param::I64(3)],
            false,
        );
        assert_eq!(
            sql,
            "SELECT 1 FROM t WHERE x = ? AND seq IN (?, ?, ?, ?) AND y > ?"
        );
        assert_eq!(padded.len(), 4);
    }

    #[test]
    fn composite_parent_values_and_expansion_preserve_tuples() {
        let mut st = step(
            "SELECT 1 WHERE (tenant_id, parent_id) IN ((?))",
            &["parent"],
        );
        st.parent.as_mut().unwrap().keys = vec![
            crate::plan::KeyRef {
                column: "tenant_id".into(),
                index: 0,
            },
            crate::plan::KeyRef {
                column: "parent_id".into(),
                index: 1,
            },
        ];
        let rows = vec![
            vec![Val::I64(1), Val::I64(2)],
            vec![Val::I64(1), Val::I64(3)],
            vec![Val::I64(1), Val::I64(2)],
            vec![Val::I64(2), Val::Null],
        ];
        let values = parent_values(
            st.parent.as_ref().unwrap(),
            rows.iter().map(Vec::as_slice),
            &[],
        );
        assert_eq!(
            values,
            vec![Param::I64(1), Param::I64(2), Param::I64(1), Param::I64(3)]
        );
        let (sql, values) = expand_in(&st, values, false);
        assert_eq!(
            sql,
            "SELECT 1 WHERE (tenant_id, parent_id) IN ((?, ?), (?, ?))"
        );
        assert_eq!(values.len(), 4);
    }

    #[test]
    fn relation_chunks_bound_sqlite_parameters_and_preserve_order() {
        let mut st = step(
            "SELECT 1 WHERE (tenant_id, parent_id) IN ((?))",
            &["parent", "param"],
        );
        st.parent.as_mut().unwrap().keys = vec![
            crate::plan::KeyRef {
                column: "tenant_id".into(),
                index: 0,
            },
            crate::plan::KeyRef {
                column: "parent_id".into(),
                index: 1,
            },
        ];
        let values = (0..600)
            .flat_map(|id| [Param::I64(1), Param::I64(id)])
            .collect();
        let chunks = relation_chunks(&st, values, "sqlite").unwrap();
        assert_eq!(chunks.len(), 3);
        assert!(chunks.iter().all(|chunk| chunk.len() <= 512));
        assert_eq!(chunks[0][0], Param::I64(1));
        assert_eq!(chunks.last().unwrap().last(), Some(&Param::I64(599)));
    }

    #[tokio::test]
    async fn loaded_plan_bundle_skips_compiler() {
        let schema = std::fs::read("../../../schema/schema.json").unwrap();
        let wasm = std::fs::read("../../../bin/ormengine.wasm").unwrap();
        let engine = Arc::new(
            Engine::new(crate::engine::EngineConfig {
                wasm: &wasm,
                schema_json: &schema,
                dialect: "sqlite",
                cache_dir: None,
            })
            .unwrap(),
        );
        let compiler = Arc::new(BundleCompiler {
            schema_hash: engine.schema_hash.clone(),
        });
        let opts = ConnectOptions::parse("sqlite", "sqlite::memory:").unwrap();
        let cfg = Config {
            aes_key: String::new(),
            blind_index_key: String::new(),
            aes_version: 1,
            aes_keys: BTreeMap::new(),
            plan_cache_size: 2,
            statement_cache_size: 2,
            on_query: None,
        };
        let db = Db::connect_with_compiler(opts, 1, engine.clone(), compiler, cfg)
            .await
            .unwrap();
        let mut req = Req::new(&engine.schema_hash, "battle");
        let canonical = canonical_json(serde_json::to_value(&req.ir).unwrap());
        let request_hash = format!(
            "{:x}",
            sha2::Sha256::digest(serde_json::to_vec(&canonical).unwrap())
        );
        let bundle = serde_json::json!({"version":1,"schema_hash":engine.schema_hash,"dialect":"sqlite","request_sha256":request_hash,"plan":{"schema_hash":engine.schema_hash,"kind":"all","steps":[{"id":0,"role":"main","sql":"SELECT 1"}]}});
        db.load_plan_bundle(&serde_json::to_vec(&bundle).unwrap(), &mut req)
            .unwrap();
        let plan = db.plan(&mut req).await.unwrap();
        assert_eq!(plan.steps[0].sql, "SELECT 1");
        db.close().await;
    }

    #[tokio::test]
    async fn sqlx_statement_cache_pressure_and_close() {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .statement_cache_capacity(2);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        for sql in ["SELECT 110", "SELECT 120", "SELECT 130", "SELECT 110"] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        pool.close().await;
        let error = sqlx::query("SELECT 1").execute(&pool).await.unwrap_err();
        assert!(matches!(error, sqlx::Error::PoolClosed));
    }

    #[tokio::test]
    async fn plan_cache_evicts_oldest_and_close_clears_entries() {
        let schema = std::fs::read("../../../schema/schema.json").unwrap();
        let wasm = std::fs::read("../../../bin/ormengine.wasm").unwrap();
        let engine = Arc::new(
            Engine::new(crate::engine::EngineConfig {
                wasm: &wasm,
                schema_json: &schema,
                dialect: "sqlite",
                cache_dir: None,
            })
            .unwrap(),
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let compiler = Arc::new(CountingPlanCompiler {
            schema_hash: engine.schema_hash.clone(),
            calls: calls.clone(),
        });
        let opts = ConnectOptions::parse("sqlite", "sqlite::memory:").unwrap();
        let cfg = Config {
            aes_key: String::new(),
            blind_index_key: String::new(),
            aes_version: 1,
            aes_keys: BTreeMap::new(),
            plan_cache_size: 2,
            statement_cache_size: 2,
            on_query: None,
        };
        let db = Db::connect_with_plan_compiler(opts, 1, engine.clone(), compiler, cfg)
            .await
            .unwrap();
        let mut requests = Vec::new();
        for kind in ["all", "count", "one"] {
            let mut request = Req::new(&engine.schema_hash, "battle");
            request.ir.kind = kind.into();
            requests.push(request);
        }
        for request in &mut requests {
            db.plan(request).await.unwrap();
        }
        db.plan(&mut requests[0]).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        db.close().await;
        assert!(db.plans.lock().unwrap().is_empty());
        assert!(db.plan_order.lock().unwrap().is_empty());
    }
}
