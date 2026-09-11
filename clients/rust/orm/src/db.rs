//! The sqlx executor: plan cache keyed by IR shape, statement reuse through
//! sqlx's per-connection cache, transactions with deadlock re-run.

use std::borrow::Cow;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::{Column, Row as _};

use crate::builder::Req;
use crate::collection::Key;
use crate::engine::Engine;
use crate::plan::{Assemble, BindSlot, Child, ParentRef, Plan, Step};
use crate::row::{decode_styled, read_cell, read_row, Cells, Src};
use crate::value::{transform, Param, Val};
use crate::{Error, Result};

/// The statement hook: `(sql, binds, duration, plan_id, err)`. Secret binds arrive masked
/// as `Param::Str("$SECRET")`; `plan_id` is the plan-cache key of the statement's plan
/// (render it as 16 lowercase hex digits, `{plan_id:016x}`, to group logs by shape).
pub type OnQuery = Box<dyn Fn(&str, &[Param], std::time::Duration, u64, Option<&Error>) + Send + Sync>;

/// The masked form of a secret bind in the hook payload and in `sql()`.
pub const SECRET_MASK: &str = "$SECRET";

/// Executor configuration: declared, never discovered.
pub struct Config {
    pub aes_key: String,
    pub on_query: Option<OnQuery>,
}

/// Cheap to clone: every field is shared. `Tx` owns a clone, so no lifetimes leak into closures.
#[derive(Clone)]
pub struct Db {
    pub pool: MySqlPool,
    pub engine: Arc<Engine>,
    cfg: Arc<Config>,
    plans: Arc<Mutex<HashMap<u64, Arc<Plan>>>>,
}

/// Rows of a select plan: the main step's rows (driver rows when the plan has no
/// relation steps, positional rows otherwise) plus every relation step's rows grouped
/// by their match column (see `related`).
pub struct Rows {
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
        let Some(sr) = self.steps.get(&ch.step) else { return Ok(Vec::new()) };
        let st = &self.plan.steps[ch.step as usize];
        if let Some(ifp) = st.parent.as_ref().and_then(|p| p.if_parent.as_ref()) {
            if !same_scalar(&parent.val(ifp.index)?, &self.params[ifp.param]) {
                return Ok(Vec::new());
            }
        }
        let pv = parent.val(ch.parent_index)?;
        if pv.is_null() {
            return Ok(Vec::new());
        }
        Ok(match sr.by_key.get(&Key::of(&pv)) {
            Some(idxs) => idxs.iter().map(|&i| sr.data[i].as_slice()).collect(),
            None => Vec::new(),
        })
    }

    /// The assembly of the step a relation child's rows come from.
    pub fn step_assemble(&self, ch: &Child) -> &Arc<Assemble> {
        self.plan.steps[ch.step as usize].assemble.as_ref().expect("relation step has an assemble")
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
    };
    a == b
}

/// Distinct non-null values a relation step binds, first-seen order, from the
/// parent rows that pass `if_parent`.
fn parent_values<'a>(pr: &ParentRef, parents: impl Iterator<Item = &'a [Val]>, params: &[Param]) -> Vec<Param> {
    let mut seen: std::collections::HashSet<Key> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for row in parents {
        if let Some(ifp) = &pr.if_parent {
            if !same_scalar(&row[ifp.index], &params[ifp.param]) {
                continue;
            }
        }
        let v = &row[pr.index];
        if v.is_null() {
            continue;
        }
        if seen.insert(Key::of(v)) {
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
    out
}

/// Rewrites the step's single `parent` placeholder into n placeholders. n is
/// rounded up to a power of two (values padded by repetition) so the prepared
/// statement cache holds one statement per size class.
fn expand_in(st: &Step, mut vals: Vec<Param>) -> (String, Vec<Param>) {
    let mut n = 1;
    while n < vals.len() {
        n <<= 1;
    }
    let last = vals.last().cloned().unwrap_or(Param::Null);
    while vals.len() < n {
        vals.push(last.clone());
    }
    let mut sql = String::with_capacity(st.sql.len() + 2 * n);
    let mut slot = 0;
    for c in st.sql.chars() {
        if c != '?' {
            sql.push(c);
            continue;
        }
        if st.bind_slots[slot].from == "parent" {
            sql.push('?');
            for _ in 1..n {
                sql.push_str(", ?");
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
    let Param::Str(s) = v else { return Err(Error::Config(format!("transform {} needs a string", b.transform))) };
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
            _ => {
                out.push(args[i].clone());
                i += 1;
            }
        }
    }
    out
}

/// Finds the match column of a relation step from the child spec that references it.
fn child_index(plan: &Plan, id: u32) -> usize {
    fn find(a: &Assemble, id: u32) -> Option<usize> {
        for ch in &a.children {
            if ch.kind != "join" && ch.step == id {
                return Some(ch.child_index);
            }
            if let Some(ja) = &ch.assemble {
                if let Some(i) = find(ja, id) {
                    return Some(i);
                }
            }
        }
        None
    }
    plan.steps.iter().filter_map(|s| s.assemble.as_deref()).find_map(|a| find(a, id)).expect("relation step without a child spec")
}

impl Db {
    pub async fn connect(opts: MySqlConnectOptions, max_connections: u32, engine: Arc<Engine>, cfg: Config) -> Result<Db> {
        let pool = MySqlPoolOptions::new().max_connections(max_connections).connect_with(opts.statement_cache_capacity(512)).await?;
        Ok(Db { pool, engine, cfg: Arc::new(cfg), plans: Arc::new(Mutex::new(HashMap::new())) })
    }

    /// Compile (or fetch from cache) the plan for the request's shape. The cache key is
    /// FNV-1a 64 of the IR bytes (`Req::shape_key`), computed without allocating them.
    pub fn plan(&self, req: &mut Req) -> Result<Arc<Plan>> {
        if let Some(e) = req.err.take() {
            return Err(e);
        }
        let key = req.shape_key();
        if let Some(p) = self.plans.lock().unwrap().get(&key) {
            return Ok(p.clone());
        }
        let body = self.engine.compile(&req.shape())?;
        let mut plan: Plan = serde_json::from_slice(&body).map_err(|e| Error::internal(e.to_string()))?;
        for st in &mut plan.steps {
            st.plan_id = key;
        }
        let plan = Arc::new(plan);
        self.plans.lock().unwrap().insert(key, plan.clone());
        Ok(plan)
    }

    fn args(&self, st: &Step, params: &[Param], parent_vals: &[Param]) -> Result<Vec<Param>> {
        let mut out = Vec::with_capacity(st.bind_slots.len() + parent_vals.len());
        for b in &st.bind_slots {
            match b.from.as_str() {
                "parent" => out.extend(parent_vals.iter().cloned()),
                "param" => out.push(param_arg(b, params)?),
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

    fn emit(&self, st: &Step, sql: &str, args: &[Param], n_parent: usize, start: std::time::Instant, err: Option<&Error>) {
        if let Some(h) = &self.cfg.on_query {
            let d = start.elapsed();
            if st.bind_slots.iter().any(|b| b.from == "secret") {
                h(sql, &masked(st, args, n_parent), d, st.plan_id, err);
            } else {
                h(sql, args, d, st.plan_id, err);
            }
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

/// The statement text of a step: the plan's SQL as is, or with its `parent` placeholder expanded.
fn statement(st: &Step, parent_vals: Vec<Param>) -> (Cow<'_, str>, Vec<Param>) {
    if parent_vals.is_empty() {
        (Cow::Borrowed(st.sql.as_str()), parent_vals)
    } else {
        let (sql, vals) = expand_in(st, parent_vals);
        (Cow::Owned(sql), vals)
    }
}

/// What terminals take: `&Db` or `&Tx`.
pub trait Exec: Sync {
    fn db(&self) -> &Db;
    /// The transaction this executor runs in; None for a `Db` (each statement on its own).
    fn tx(&self) -> Option<&Tx>;
    /// Runs a select step; `parent_vals` are the values for its `parent` slot (empty for the main step).
    fn query(&self, st: &Step, params: &[Param], parent_vals: Vec<Param>) -> impl Future<Output = Result<Vec<MySqlRow>>> + Send;
    fn execute(&self, st: &Step, params: &[Param]) -> impl Future<Output = Result<(u64, u64)>> + Send;
}

impl Exec for Db {
    fn db(&self) -> &Db {
        self
    }

    fn tx(&self) -> Option<&Tx> {
        None
    }

    async fn query(&self, st: &Step, params: &[Param], parent_vals: Vec<Param>) -> Result<Vec<MySqlRow>> {
        let (sql, parent_vals) = statement(st, parent_vals);
        let args = self.args(st, params, &parent_vals)?;
        let mut q = sqlx::query(sqlx::AssertSqlSafe(&*sql));
        for a in &args {
            q = bind(q, a);
        }
        let start = std::time::Instant::now();
        let r = q.fetch_all(&self.pool).await.map_err(Error::from);
        self.emit(st, &sql, &args, parent_vals.len(), start, r.as_ref().err());
        r
    }

    async fn execute(&self, st: &Step, params: &[Param]) -> Result<(u64, u64)> {
        let args = self.args(st, params, &[])?;
        let mut q = sqlx::query(sqlx::AssertSqlSafe(st.sql.as_str()));
        for a in &args {
            q = bind(q, a);
        }
        let start = std::time::Instant::now();
        let r = q.execute(&self.pool).await.map_err(Error::from);
        self.emit(st, &st.sql, &args, 0, start, r.as_ref().err());
        let r = r?;
        Ok((r.last_insert_id(), r.rows_affected()))
    }
}

impl Exec for Tx {
    fn db(&self) -> &Db {
        &self.db
    }

    fn tx(&self) -> Option<&Tx> {
        Some(self)
    }

    async fn query(&self, st: &Step, params: &[Param], parent_vals: Vec<Param>) -> Result<Vec<MySqlRow>> {
        let (sql, parent_vals) = statement(st, parent_vals);
        let args = self.db.args(st, params, &parent_vals)?;
        let mut q = sqlx::query(sqlx::AssertSqlSafe(&*sql));
        for a in &args {
            q = bind(q, a);
        }
        let mut guard = self.inner.lock().await;
        let tx = guard.as_mut().ok_or_else(|| Error::Config("transaction already finished".into()))?;
        let start = std::time::Instant::now();
        let r = q.fetch_all(&mut **tx).await.map_err(Error::from);
        self.db.emit(st, &sql, &args, parent_vals.len(), start, r.as_ref().err());
        r
    }

    async fn execute(&self, st: &Step, params: &[Param]) -> Result<(u64, u64)> {
        let args = self.db.args(st, params, &[])?;
        let mut q = sqlx::query(sqlx::AssertSqlSafe(st.sql.as_str()));
        for a in &args {
            q = bind(q, a);
        }
        let mut guard = self.inner.lock().await;
        let tx = guard.as_mut().ok_or_else(|| Error::Config("transaction already finished".into()))?;
        let start = std::time::Instant::now();
        let r = q.execute(&mut **tx).await.map_err(Error::from);
        self.db.emit(st, &st.sql, &args, 0, start, r.as_ref().err());
        let r = r?;
        Ok((r.last_insert_id(), r.rows_affected()))
    }
}

/// Run the select plan of a request: the main step, then every relation step.
pub async fn select(ex: &impl Exec, req: &mut Req, kind: &str) -> Result<Rows> {
    req.ir.kind = kind.into();
    let plan = ex.db().plan(req)?;
    run_plan(ex, plan, req).await
}

async fn run_plan(ex: &impl Exec, plan: Arc<Plan>, req: &mut Req) -> Result<Rows> {
    let st = &plan.steps[0];
    let asm = st.assemble.clone().ok_or_else(|| Error::internal("no assemble"))?;
    let raw = ex.query(st, &req.params, Vec::new()).await?;
    let has_relations = plan.steps.iter().skip(1).any(|s| s.role == "relation");
    // Relation steps read parent values positionally and attach by key; without them the
    // driver rows go straight to the generated struct.
    let cells: Vec<Cells> = if has_relations {
        let n = asm.total_columns();
        let mut data: Vec<Vec<Val>> = raw.iter().map(|r| read_row(r, n)).collect::<Result<_>>()?;
        decode_styled(&asm, &mut data)?;
        data.into_iter().map(Cells::Pos).collect()
    } else {
        raw.into_iter().map(Cells::Raw).collect()
    };
    let mut rows = Rows { assemble: asm, cells, plan: plan.clone(), steps: HashMap::new(), params: Vec::new() };
    for st in plan.steps.iter().skip(1) {
        if st.role != "relation" {
            continue;
        }
        let pr = st.parent.as_ref().expect("relation step has a parent");
        let vals = if pr.step == 0 {
            parent_values(pr, rows.positional(), &req.params)
        } else {
            parent_values(pr, rows.steps[&pr.step].data.iter().map(Vec::as_slice), &req.params)
        };
        let mut sr = StepRows { data: Vec::new(), by_key: HashMap::new() };
        if !vals.is_empty() {
            let asm = st.assemble.as_ref().expect("relation step has an assemble");
            sr.data = ex.query(st, &req.params, vals).await?.iter().map(|r| read_row(r, asm.total_columns())).collect::<Result<_>>()?;
            decode_styled(asm, &mut sr.data)?;
            let ci = child_index(&plan, st.id);
            for (j, row) in sr.data.iter().enumerate() {
                sr.by_key.entry(Key::of(&row[ci])).or_default().push(j);
            }
        }
        rows.steps.insert(st.id, sr);
    }
    rows.params = std::mem::take(&mut req.params);
    Ok(rows)
}

pub async fn scalar(ex: &impl Exec, req: &mut Req, kind: &str) -> Result<Val> {
    req.ir.kind = kind.into();
    let plan = ex.db().plan(req)?;
    let rows = ex.query(&plan.steps[0], &req.params, Vec::new()).await?;
    Ok(match rows.first() {
        Some(r) => read_cell(r, 0)?,
        None => Val::Null,
    })
}

/// Runs the request's raw statement (kind raw, step role raw, no assemble) and returns
/// its rows keyed by the driver's column names in column order; cells are decoded by
/// column type like any positional row (no codec, no assembly).
pub async fn raw(ex: &impl Exec, req: &mut Req) -> Result<Vec<indexmap::IndexMap<String, Val>>> {
    req.ir.kind = "raw".into();
    let plan = ex.db().plan(req)?;
    let rows = ex.query(&plan.steps[0], &req.params, Vec::new()).await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let n = r.len();
        let vals = read_row(r, n)?;
        let mut m = indexmap::IndexMap::with_capacity(n);
        for (i, v) in vals.into_iter().enumerate() {
            m.insert(r.column(i).name().to_owned(), v);
        }
        out.push(m);
    }
    Ok(out)
}

pub async fn paginate(ex: &impl Exec, req: &mut Req) -> Result<(Rows, i64)> {
    req.ir.kind = "paginate".into();
    let plan = ex.db().plan(req)?;
    let rows = run_plan(ex, plan.clone(), req).await?;
    let count = plan.steps.iter().find(|s| s.role == "count").expect("paginate plan has a count step");
    let cnt = ex.query(count, &rows.params, Vec::new()).await?;
    let total = match cnt.first() {
        Some(r) => read_cell(r, 0)?.as_i64(),
        None => 0,
    };
    Ok((rows, total))
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
pub fn sql(ex: &impl Exec, req: &mut Req, kind: &str) -> Result<Sql> {
    req.ir.kind = kind.into();
    let plan = ex.db().plan(req)?;
    let st = &plan.steps[0];
    let mut binds = Vec::with_capacity(st.bind_slots.len());
    for b in &st.bind_slots {
        match b.from.as_str() {
            "param" => binds.push(param_arg(b, &req.params)?),
            "secret" => binds.push(Param::Str(SECRET_MASK.into())),
            other => return Err(Error::Config(format!("bind from {other}"))),
        }
    }
    Ok(Sql { sql: st.sql.clone(), binds, plan_id: st.plan_id })
}

/// Whether a joined node's slice of the row is present (its first column is not NULL).
pub fn join_present(src: &mut impl Src, a: &Assemble) -> bool {
    !a.columns.is_empty() && !src.is_null(a.columns[0].index)
}
