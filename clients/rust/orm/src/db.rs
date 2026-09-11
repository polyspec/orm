//! The sqlx executor: plan cache keyed by IR shape, statement reuse through
//! sqlx's per-connection cache, transactions with deadlock re-run.

use std::collections::HashMap;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};

use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::{Column, Row as _, TypeInfo};

use crate::builder::Req;
use crate::engine::Engine;
use crate::plan::{Assemble, Plan, Step};
use crate::value::{transform, Param, Val};
use crate::{Error, Result};

/// Executor configuration: declared, never discovered.
pub struct Config {
    pub aes_key: String,
    pub on_query: Option<Box<dyn Fn(&str, &[Param], std::time::Duration, Option<&Error>) + Send + Sync>>,
}

/// Cheap to clone: every field is shared. `Tx` owns a clone, so no lifetimes leak into closures.
#[derive(Clone)]
pub struct Db {
    pub pool: MySqlPool,
    pub engine: Arc<Engine>,
    cfg: Arc<Config>,
    plans: Arc<Mutex<HashMap<u64, Arc<Plan>>>>,
}

/// Rows of one select step, positional.
pub struct Rows {
    pub assemble: Assemble,
    pub data: Vec<Vec<Val>>,
}

impl Db {
    pub async fn connect(opts: MySqlConnectOptions, max_connections: u32, engine: Arc<Engine>, cfg: Config) -> Result<Db> {
        let pool = MySqlPoolOptions::new().max_connections(max_connections).connect_with(opts.statement_cache_capacity(512)).await?;
        Ok(Db { pool, engine, cfg: Arc::new(cfg), plans: Arc::new(Mutex::new(HashMap::new())) })
    }

    /// Compile (or fetch from cache) the plan for the request's shape.
    pub fn plan(&self, req: &mut Req) -> Result<Arc<Plan>> {
        let shape = req.shape();
        let mut h = std::collections::hash_map::DefaultHasher::new();
        shape.hash(&mut h);
        let key = h.finish();
        if let Some(p) = self.plans.lock().unwrap().get(&key) {
            return Ok(p.clone());
        }
        let body = self.engine.compile(&shape)?;
        let plan: Plan = serde_json::from_slice(&body).map_err(|e| Error::Engine { code: "INTERNAL".into(), msg: e.to_string() })?;
        let plan = Arc::new(plan);
        self.plans.lock().unwrap().insert(key, plan.clone());
        Ok(plan)
    }

    fn args(&self, st: &Step, params: &[Param]) -> Result<Vec<Param>> {
        let mut out = Vec::with_capacity(st.bind_slots.len());
        for b in &st.bind_slots {
            match b.from.as_str() {
                "param" => {
                    let v = &params[b.param];
                    if b.transform.is_empty() {
                        out.push(v.clone());
                    } else {
                        let Param::Str(s) = v else { return Err(Error::Config(format!("transform {} needs a string", b.transform))) };
                        out.push(Param::Str(transform(&b.transform, s)));
                    }
                }
                "secret" => {
                    if b.name != "aes" || self.cfg.aes_key.is_empty() {
                        return Err(Error::Config(format!("secret {} not configured", b.name)));
                    }
                    out.push(Param::Str(self.cfg.aes_key.clone()));
                }
                other => return Err(Error::Config(format!("bind from {other}"))),
            }
        }
        Ok(out)
    }

    fn emit(&self, sql: &str, args: &[Param], start: std::time::Instant, err: Option<&Error>) {
        if let Some(h) = &self.cfg.on_query {
            h(sql, args, start.elapsed(), err);
        }
    }

    /// Run `f` in a transaction; on deadlock re-run it in a new transaction (max 3).
    pub async fn transaction<T, F, Fut>(&self, f: F) -> Result<T>
    where
        F: Fn(Tx) -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        let mut last = None;
        for attempt in 0..3u32 {
            let tx = Tx { inner: Arc::new(tokio::sync::Mutex::new(Some(self.pool.begin().await?))), db: self.clone() };
            match f(tx.clone()).await {
                Ok(v) => {
                    tx.commit().await?;
                    return Ok(v);
                }
                Err(e) => {
                    tx.rollback().await;
                    if !e.is_deadlock() {
                        return Err(e);
                    }
                    last = Some(e);
                    let jitter = rand::random::<u64>() % 20;
                    tokio::time::sleep(std::time::Duration::from_millis((50u64 << attempt) + jitter)).await;
                }
            }
        }
        Err(last.unwrap())
    }
}

/// A transaction handle: cheap to clone, so closures can `async move` it.
#[derive(Clone)]
pub struct Tx {
    inner: Arc<tokio::sync::Mutex<Option<sqlx::Transaction<'static, sqlx::MySql>>>>,
    db: Db,
}

impl Tx {
    async fn commit(&self) -> Result<()> {
        if let Some(t) = self.inner.lock().await.take() {
            t.commit().await?;
        }
        Ok(())
    }

    async fn rollback(&self) {
        if let Some(t) = self.inner.lock().await.take() {
            let _ = t.rollback().await;
        }
    }
}

fn bind<'q>(q: sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments>, p: &'q Param) -> sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments> {
    match p {
        Param::Null => q.bind(Option::<i64>::None),
        Param::Bool(b) => q.bind(*b),
        Param::I64(x) => q.bind(*x),
        Param::F64(x) => q.bind(*x),
        Param::Str(s) => q.bind(s.as_str()),
        Param::Bytes(b) => q.bind(b.as_slice()),
        Param::DateTime(t) => q.bind(*t),
        Param::Date(d) => q.bind(*d),
    }
}

fn read_row(row: &MySqlRow, n: usize) -> Vec<Val> {
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let col = row.column(i);
        let t = col.type_info().name();
        let v = match t {
            "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED" | "YEAR" => {
                match row.try_get::<Option<i64>, _>(i) {
                    Ok(Some(x)) => Val::I64(x),
                    Ok(None) => Val::Null,
                    Err(_) => row.try_get::<Option<u64>, _>(i).ok().flatten().map(|x| Val::I64(x as i64)).unwrap_or(Val::Null),
                }
            }
            "FLOAT" | "DOUBLE" => row.try_get::<Option<f64>, _>(i).ok().flatten().map(Val::F64).unwrap_or(Val::Null),
            // NEWDECIMAL is only compatible with a decimal type in sqlx; we surface it as f64 like Go/PHP.
            "DECIMAL" => row.try_get::<Option<rust_decimal::Decimal>, _>(i).ok().flatten().map(|d| Val::F64(rust_decimal::prelude::ToPrimitive::to_f64(&d).unwrap_or(0.0))).unwrap_or(Val::Null),
            // sqlx's NaiveDateTime only accepts DATETIME; TIMESTAMP columns decode as DateTime<Utc> (session tz is UTC).
            "DATETIME" => row.try_get::<Option<chrono::NaiveDateTime>, _>(i).ok().flatten().map(Val::DateTime).unwrap_or(Val::Null),
            "TIMESTAMP" => row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i).ok().flatten().map(|t| Val::DateTime(t.naive_utc())).unwrap_or(Val::Null),
            "DATE" => row.try_get::<Option<chrono::NaiveDate>, _>(i).ok().flatten().map(Val::Date).unwrap_or(Val::Null),
            "BOOLEAN" => row.try_get::<Option<bool>, _>(i).ok().flatten().map(Val::Bool).unwrap_or(Val::Null),
            "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "VARBINARY" | "BINARY" => {
                // AES_DECRYPT yields BLOB; treat as text when it decodes as UTF-8 (compatibility returns strings).
                match row.try_get::<Option<Vec<u8>>, _>(i).ok().flatten() {
                    Some(b) => match String::from_utf8(b) {
                        Ok(s) => Val::Str(s),
                        Err(e) => Val::Bytes(e.into_bytes()),
                    },
                    None => Val::Null,
                }
            }
            _ => row.try_get::<Option<String>, _>(i).ok().flatten().map(Val::Str).unwrap_or(Val::Null),
        };
        out.push(v);
    }
    out
}

/// What terminals take: `&Db` or `&Tx`.
pub trait Exec: Sync {
    fn db(&self) -> &Db;
    fn query(&self, st: &Step, params: &[Param]) -> impl Future<Output = Result<Vec<MySqlRow>>> + Send;
    fn execute(&self, st: &Step, params: &[Param]) -> impl Future<Output = Result<(u64, u64)>> + Send;
}

impl Exec for Db {
    fn db(&self) -> &Db {
        self
    }

    async fn query(&self, st: &Step, params: &[Param]) -> Result<Vec<MySqlRow>> {
        let args = self.args(st, params)?;
        let mut q = sqlx::query(sqlx::AssertSqlSafe(st.sql.clone()));
        for a in &args {
            q = bind(q, a);
        }
        let start = std::time::Instant::now();
        let r = q.fetch_all(&self.pool).await.map_err(Error::from);
        self.emit(&st.sql, &args, start, r.as_ref().err());
        r
    }

    async fn execute(&self, st: &Step, params: &[Param]) -> Result<(u64, u64)> {
        let args = self.args(st, params)?;
        let mut q = sqlx::query(sqlx::AssertSqlSafe(st.sql.clone()));
        for a in &args {
            q = bind(q, a);
        }
        let start = std::time::Instant::now();
        let r = q.execute(&self.pool).await.map_err(Error::from);
        self.emit(&st.sql, &args, start, r.as_ref().err());
        let r = r?;
        Ok((r.last_insert_id(), r.rows_affected()))
    }
}

impl Exec for Tx {
    fn db(&self) -> &Db {
        &self.db
    }

    async fn query(&self, st: &Step, params: &[Param]) -> Result<Vec<MySqlRow>> {
        let args = self.db.args(st, params)?;
        let mut q = sqlx::query(sqlx::AssertSqlSafe(st.sql.clone()));
        for a in &args {
            q = bind(q, a);
        }
        let mut guard = self.inner.lock().await;
        let tx = guard.as_mut().ok_or_else(|| Error::Config("transaction already finished".into()))?;
        let start = std::time::Instant::now();
        let r = q.fetch_all(&mut **tx).await.map_err(Error::from);
        self.db.emit(&st.sql, &args, start, r.as_ref().err());
        r
    }

    async fn execute(&self, st: &Step, params: &[Param]) -> Result<(u64, u64)> {
        let args = self.db.args(st, params)?;
        let mut q = sqlx::query(sqlx::AssertSqlSafe(st.sql.clone()));
        for a in &args {
            q = bind(q, a);
        }
        let mut guard = self.inner.lock().await;
        let tx = guard.as_mut().ok_or_else(|| Error::Config("transaction already finished".into()))?;
        let start = std::time::Instant::now();
        let r = q.execute(&mut **tx).await.map_err(Error::from);
        self.db.emit(&st.sql, &args, start, r.as_ref().err());
        let r = r?;
        Ok((r.last_insert_id(), r.rows_affected()))
    }
}

/// Run the main select step of a request.
pub async fn select(ex: &impl Exec, req: &mut Req, kind: &str) -> Result<Rows> {
    req.ir.kind = kind.into();
    let plan = ex.db().plan(req)?;
    let st = &plan.steps[0];
    let asm = st.assemble.clone().ok_or_else(|| Error::Engine { code: "INTERNAL".into(), msg: "no assemble".into() })?;
    let n = asm.total_columns();
    let rows = ex.query(st, &req.params).await?;
    let data = rows.iter().map(|r| read_row(r, n)).collect();
    Ok(Rows { assemble: asm, data })
}

pub async fn scalar(ex: &impl Exec, req: &mut Req, kind: &str) -> Result<Val> {
    req.ir.kind = kind.into();
    let plan = ex.db().plan(req)?;
    let rows = ex.query(&plan.steps[0], &req.params).await?;
    Ok(rows.first().map(|r| read_row(r, 1).remove(0)).unwrap_or(Val::Null))
}

pub async fn paginate(ex: &impl Exec, req: &mut Req) -> Result<(Rows, i64)> {
    req.ir.kind = "paginate".into();
    let plan = ex.db().plan(req)?;
    let st = &plan.steps[0];
    let asm = st.assemble.clone().ok_or_else(|| Error::Engine { code: "INTERNAL".into(), msg: "no assemble".into() })?;
    let n = asm.total_columns();
    let rows = ex.query(st, &req.params).await?;
    let data = rows.iter().map(|r| read_row(r, n)).collect();
    let cnt = ex.query(&plan.steps[1], &req.params).await?;
    let total = cnt.first().map(|r| read_row(r, 1).remove(0).as_i64()).unwrap_or(0);
    Ok((Rows { assemble: asm, data }, total))
}

/// insert/update/delete. Returns (last_insert_id, affected). Optimistic updates
/// that match no row fail with OptimisticLock.
pub async fn write(ex: &impl Exec, req: &mut Req, kind: &str) -> Result<(u64, u64)> {
    req.ir.kind = kind.into();
    let plan = ex.db().plan(req)?;
    let (id, affected) = ex.execute(&plan.steps[0], &req.params).await?;
    if kind == "update" && req.ir.optimistic.is_some() && affected == 0 {
        return Err(Error::OptimisticLock);
    }
    Ok((id, affected))
}

/// Slice of a positional row belonging to one assemble node.
pub fn slice<'a>(vals: &'a [Val], a: &Assemble) -> &'a [Val] {
    if a.columns.is_empty() {
        return &[];
    }
    let start = a.columns[0].index;
    &vals[start..start + a.columns.len()]
}

pub fn join_present(vals: &[Val], a: &Assemble) -> bool {
    !a.columns.is_empty() && !vals[a.columns[0].index].is_null()
}
