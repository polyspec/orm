//! Generated models: the traits they implement, assembly of rows into models,
//! terminals, and writes.

use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use indexmap::IndexMap;

use crate::collection::{AnyCollection, Collection, Key, Page};
use crate::core::{config, CondGroup, CondKind, CondNode, Core, PredSpec, PredValue, RelSpec, SetSpec, SetValue};
use crate::db::{Db, Executor, Statement};
use crate::driver::{child_keys, first_cell, parent_values, positional, relation_chunks, same_scalar};
use crate::ir;
use crate::plan::{Assemble, Plan};
use crate::request::{build, result_name, Req};
use crate::schema::{EntitySchema, Schema};
use crate::tx::resolve;
use crate::value::{Param, Val};
use crate::{codes, Error, Result};

/// Implemented by every generated model.
pub trait Model: Clone + Send + Sync + 'static {
    fn entity() -> &'static Entity;
    fn core(&self) -> &Core;
    fn core_mut(&mut self) -> &mut Core;
    fn from_core(core: Core) -> Self;
    fn into_core(self) -> Core;
    /// Stores a decoded column value; false when name is not a column.
    fn assign(&mut self, name: &str, value: Val) -> bool;
    /// Reads a column value; None when name is not a column.
    fn value(&self, name: &str) -> Option<Val>;
}

/// A model seen without its type.
pub trait AnyModel: Any + Send + Sync {
    fn core_dyn(&self) -> &Core;
    fn core_dyn_mut(&mut self) -> &mut Core;
    fn assign_dyn(&mut self, name: &str, value: Val) -> bool;
    fn value_dyn(&self, name: &str) -> Option<Val>;
    fn as_any(&self) -> &dyn Any;
    fn into_any(self: Box<Self>) -> Box<dyn Any>;
}

impl<M: Model> AnyModel for M {
    fn core_dyn(&self) -> &Core {
        self.core()
    }
    fn core_dyn_mut(&mut self) -> &mut Core {
        self.core_mut()
    }
    fn assign_dyn(&mut self, name: &str, value: Val) -> bool {
        self.assign(name, value)
    }
    fn value_dyn(&self, name: &str) -> Option<Val> {
        self.value(name)
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn into_any(self: Box<Self>) -> Box<dyn Any> {
        self
    }
}

/// Loaded models with their collection keys.
pub type Boxed = Vec<(Key, Box<dyn AnyModel>)>;

type Shared = Vec<(Key, Arc<dyn AnyModel>)>;

/// The descriptor of one generated model type.
pub struct Entity {
    pub name: &'static str,
    pub schema: &'static Schema,
    pub new: fn(Core) -> Box<dyn AnyModel>,
    pub collect: fn(Boxed, HashMap<Key, serde_json::Value>) -> Arc<dyn AnyCollection>,
}

impl Entity {
    /// The manifest entry of the model.
    pub fn entity_schema(&self) -> Result<EntitySchema> {
        Ok(self.schema.manifest()?.entity(self.name)?.clone())
    }
}

/// The descriptor functions of a model type.
pub fn new_boxed<M: Model>(core: Core) -> Box<dyn AnyModel> {
    Box::new(M::from_core(core))
}

pub fn collect_boxed<M: Model>(items: Boxed, fetched: HashMap<Key, serde_json::Value>) -> Arc<dyn AnyCollection> {
    Arc::new(Collection::<M>::from_boxes(items, fetched))
}

#[derive(Clone)]
pub(crate) enum RelatedValue {
    One(Option<Arc<dyn AnyModel>>),
    Many(Arc<dyn AnyCollection>),
}

#[derive(Clone)]
pub(crate) struct Related {
    pub value: RelatedValue,
    pub cascade: bool,
    pub flat: bool,
}

/// The state of a loaded or created row.
#[derive(Clone, Default)]
pub struct RowState {
    pub(crate) loaded: bool,
    pub(crate) names: Vec<String>,
    pub(crate) hidden: HashSet<String>,
    pub(crate) original: HashMap<String, Param>,
    pub(crate) extra: IndexMap<String, Val>,
    pub(crate) related: IndexMap<String, Related>,
}

impl RowState {
    fn add_name(&mut self, name: &str) {
        if !self.names.iter().any(|n| n == name) {
            self.names.push(name.to_owned());
        }
    }
}

impl Core {
    /// The related row of a relation or join result.
    pub fn related_one<M: Model>(&self, name: &str) -> Option<&M> {
        match &self.row.as_ref()?.related.get(name)?.value {
            RelatedValue::One(Some(m)) => m.as_any().downcast_ref::<M>(),
            _ => None,
        }
    }

    /// The related rows of a relation result.
    pub fn related_many<M: Model>(&self, name: &str) -> Option<&Collection<M>> {
        match &self.row.as_ref()?.related.get(name)?.value {
            RelatedValue::Many(c) => c.as_any().downcast_ref::<Collection<M>>(),
            _ => None,
        }
    }
}

pub(crate) fn val_param(v: &Val) -> Param {
    match v {
        Val::Null => Param::Null,
        Val::I64(x) => Param::I64(*x),
        Val::F64(x) => Param::F64(*x),
        Val::Str(s) => Param::Str(s.clone()),
        Val::Bytes(b) => Param::Bytes(b.clone()),
        Val::DateTime(t) => Param::DateTime(*t),
        Val::Date(d) => Param::Date(*d),
        Val::Bool(b) => Param::Bool(*b),
        Val::Json(j) => Param::Str(j.to_string()),
        Val::Ordered(j) => Param::Str(j.compact()),
    }
}

pub(crate) fn param_val(p: &Param) -> Val {
    match p {
        Param::Null => Val::Null,
        Param::Bool(b) => Val::Bool(*b),
        Param::I64(x) => Val::I64(*x),
        Param::F64(x) => Val::F64(*x),
        Param::Str(s) => Val::Str(s.clone()),
        Param::Bytes(b) => Val::Bytes(b.clone()),
        Param::DateTime(t) => Val::DateTime(*t),
        Param::Date(d) => Val::Date(*d),
        Param::Point(p) => Val::Str(crate::value::point_text(*p).unwrap_or_default()),
    }
}

// ---- execution of select plans ----

struct StepRows {
    data: Vec<Vec<Val>>,
    by_key: HashMap<Key, Vec<usize>>,
}

struct QueryResult {
    plan: Arc<Plan>,
    main: Vec<Vec<Val>>,
    steps: HashMap<u32, StepRows>,
    params: Vec<Param>,
}

impl QueryResult {
    fn related(&self, ch: &crate::plan::Child, parent: &[Val]) -> Vec<&[Val]> {
        let Some(sr) = self.steps.get(&ch.step) else { return Vec::new() };
        let st = &self.plan.steps[ch.step as usize];
        if let Some(ifp) = st.parent.as_ref().and_then(|p| p.if_parent.as_ref()) {
            if !same_scalar(&parent[ifp.index], &self.params[ifp.param]) {
                return Vec::new();
            }
        }
        let Some(key) = Key::of_row(parent, &ch.parent_keys) else { return Vec::new() };
        match sr.by_key.get(&key) {
            Some(idxs) => idxs.iter().map(|&i| sr.data[i].as_slice()).collect(),
            None => Vec::new(),
        }
    }
}

fn bind_limit(driver: &str) -> usize {
    if driver == "sqlite" {
        999
    } else {
        65535
    }
}

/// Splits a root IN list that exceeds the bind limit into requests whose
/// results together equal the original result.
fn root_in_parts(req: &Req, binds: usize, driver: &str) -> Result<Vec<Req>> {
    let limit = bind_limit(driver);
    if binds <= limit {
        return Ok(Vec::new());
    }
    let too_large =
        || Error::Engine { code: codes::IR_INVALID.into(), msg: format!("the statement needs {binds} bind parameters but {driver} permits {limit}") };
    let q = &req.ir.query;
    let Some(where_) = &q.where_ else { return Err(too_large()) };
    if q.limit.is_some() || !q.order.is_empty() || !q.group_by.is_empty() || !q.group_by_expr.is_empty() {
        return Err(too_large());
    }
    let conn_of = |item: &ir::Item| match item {
        ir::Item::Pred { pred } => pred.conn.clone(),
        ir::Item::Group { group } => group.conn.clone(),
        ir::Item::Joined { joined } => joined.conn.clone(),
    };
    let mut target: Option<usize> = None;
    for (i, item) in where_.items.iter().enumerate() {
        if conn_of(item) == "or" || where_.items.get(i + 1).map(|n| conn_of(n) == "or").unwrap_or(false) {
            return Err(too_large());
        }
        if let ir::Item::Pred { pred } = item {
            if pred.op == "in" && pred.sub.is_none() {
                let longer = match target {
                    Some(t) => match &where_.items[t] {
                        ir::Item::Pred { pred: current } => pred.ps.len() > current.ps.len(),
                        _ => true,
                    },
                    None => true,
                };
                if longer {
                    target = Some(i);
                }
            }
        }
    }
    let Some(target) = target else { return Err(too_large()) };
    let ps = match &where_.items[target] {
        ir::Item::Pred { pred } => pred.ps.clone(),
        _ => unreachable!(),
    };
    let available = limit.saturating_sub(binds - ps.len());
    if available == 0 {
        return Err(too_large());
    }
    let mut chunk = 1;
    while chunk * 2 <= available {
        chunk *= 2;
    }
    let mut seen = HashSet::new();
    let unique: Vec<usize> = ps.into_iter().filter(|&i| seen.insert(val_param_key(&req.params[i]))).collect();
    let mut parts = Vec::new();
    for group in unique.chunks(chunk) {
        let mut part = req.clone();
        let mut ps = group.to_vec();
        let last = *ps.last().unwrap();
        let mut n = 1;
        while n < ps.len() {
            n <<= 1;
        }
        ps.resize(n, last);
        if let Some(ir::Item::Pred { pred }) = part.ir.query.where_.as_mut().map(|w| &mut w.items[target]) {
            pred.ps = ps;
        }
        parts.push(part);
    }
    Ok(parts)
}

fn val_param_key(p: &Param) -> String {
    format!("{p:?}")
}

async fn select(ex: &Executor, req: &mut Req) -> Result<QueryResult> {
    let db = ex.db().clone();
    let plan = db.plan(req).await?;
    let st = &plan.steps[0];
    let asm = st.assemble.clone().ok_or_else(|| Error::internal("no assemble"))?;
    let aes_keys = &db.inner.cfg.aes_keys;
    let parts = root_in_parts(req, st.bind_slots.len(), db.driver())?;
    let mut main = Vec::new();
    if parts.is_empty() {
        let raw = ex.query(st, &req.params, Vec::new()).await?;
        main = positional(&raw, &asm, aes_keys, db.inner.zone)?;
    } else {
        let mut seen = HashSet::new();
        for mut part in parts {
            let pp = db.plan(&mut part).await?;
            let pst = &pp.steps[0];
            let pasm = pst.assemble.clone().ok_or_else(|| Error::internal("no assemble"))?;
            let raw = ex.query(pst, &part.params, Vec::new()).await?;
            for row in positional(&raw, &pasm, aes_keys, db.inner.zone)? {
                if seen.insert(Key::of_row(&row, &pasm.key)) {
                    main.push(row);
                }
            }
        }
    }
    let mut out = QueryResult { plan: plan.clone(), main, steps: HashMap::new(), params: req.params.clone() };
    for st in plan.steps.iter().skip(1) {
        if st.role != "relation" {
            continue;
        }
        let pr = st.parent.as_ref().expect("relation step has a parent");
        let vals = if pr.step == 0 {
            parent_values(pr, out.main.iter().map(Vec::as_slice), &req.params)
        } else {
            parent_values(pr, out.steps[&pr.step].data.iter().map(Vec::as_slice), &req.params)
        };
        let mut sr = StepRows { data: Vec::new(), by_key: HashMap::new() };
        if !vals.is_empty() {
            let asm = st.assemble.as_ref().expect("relation step has an assemble");
            for chunk in relation_chunks(st, vals, db.driver())? {
                let raw = ex.query(st, &req.params, chunk).await?;
                sr.data.extend(positional(&raw, asm, aes_keys, db.inner.zone)?);
            }
            let keys = child_keys(&plan, st.id);
            for (j, row) in sr.data.iter().enumerate() {
                if let Some(key) = Key::of_row(row, &keys) {
                    sr.by_key.entry(key).or_default().push(j);
                }
            }
        }
        out.steps.insert(st.id, sr);
    }
    Ok(out)
}

// ---- assembly ----

struct Assembler<'a> {
    res: &'a QueryResult,
    conn: Option<Db>,
}

/// A model under assembly: children attach before it is moved into its parent.
struct Built {
    model: Box<dyn AnyModel>,
    builder: u64,
}

impl<'a> Assembler<'a> {
    fn model(&mut self, b: &Core, asm: &Assemble, row: &[Val]) -> Result<Built> {
        let mut m = (b.ent.new)(Core::new(b.ent));
        {
            let core = m.core_dyn_mut();
            core.conn = self.conn.clone();
        }
        let mut st = RowState { loaded: true, ..Default::default() };
        for col in &asm.columns {
            let v = row[col.index].clone();
            if col.hidden {
                st.hidden.insert(col.name.clone());
            }
            st.add_name(&col.name);
            if !col.column.is_empty() && col.column == col.name && m.assign_dyn(&col.name, v.clone()) {
                continue;
            }
            st.extra.insert(col.name.clone(), v);
        }
        for key in &asm.key {
            let name = asm.columns.iter().find(|c| c.index == key.index).map(|c| c.name.clone()).unwrap_or_default();
            if let Some(v) = m.value_dyn(&name) {
                st.original.insert(name, val_param(&v));
            }
        }
        if let Ok(ent) = b.ent.entity_schema() {
            let updated = ent.updated_column();
            if !updated.is_empty() && st.names.iter().any(|n| n == updated) {
                if let Some(v) = m.value_dyn(updated) {
                    st.original.insert(updated.to_owned(), val_param(&v));
                }
            }
        }
        for (name, value) in &b.news {
            m.core_dyn_mut().news.insert(name.clone(), value.clone());
        }
        for ch in &asm.children {
            if ch.kind == "join" {
                let child = b
                    .joins
                    .iter()
                    .find(|j| result_name(&j.child, false) == ch.rel)
                    .map(|j| j.child.as_ref())
                    .ok_or_else(|| Error::internal(format!("join result {} without a model", ch.rel)))?;
                let casm = ch.assemble.as_ref().expect("join child has an assemble");
                let present = casm.columns.first().map(|c| !row[c.index].is_null()).unwrap_or(false);
                let value = if present {
                    let built = self.model(child, casm, row)?;
                    Some(Arc::from(built.model))
                } else {
                    None
                };
                st.related.insert(ch.rel.clone(), Related { value: RelatedValue::One(value), cascade: false, flat: false });
                continue;
            }
            let (child, many) = b
                .relations
                .iter()
                .find(|r| result_name(&r.child, r.many) == ch.rel)
                .map(|r| (r.child.as_ref(), r.many))
                .ok_or_else(|| Error::internal(format!("relation result {} without a model", ch.rel)))?;
            let rows: Vec<Vec<Val>> = self.res.related(ch, row).into_iter().map(|r| r.to_vec()).collect();
            let casm = self.res.plan.steps[ch.step as usize].assemble.clone().expect("relation step has an assemble");
            if many {
                let mut items = Vec::new();
                for cr in &rows {
                    let built = self.model(child, &casm, cr)?;
                    let key = collection_key(child, built.model.as_ref(), &casm, cr);
                    items.push((key, built.model));
                }
                let coll = (child.ent.collect)(items, HashMap::new());
                st.related.insert(ch.rel.clone(), Related { value: RelatedValue::Many(coll), cascade: ch.cascade, flat: false });
            } else {
                let value = match rows.first() {
                    Some(cr) => Some(Arc::from(self.model(child, &casm, cr)?.model)),
                    None => None,
                };
                st.related.insert(ch.rel.clone(), Related { value: RelatedValue::One(value), cascade: ch.cascade, flat: ch.flatten });
            }
        }
        m.core_dyn_mut().row = Some(st);
        Ok(Built { model: m, builder: b.id })
    }
}

fn collection_key(c: &Core, m: &dyn AnyModel, asm: &Assemble, row: &[Val]) -> Key {
    if let Some(f) = &c.fetch_key {
        return f(m);
    }
    if !c.key_name.is_empty() {
        if let Some(v) = m.value_dyn(&c.key_name) {
            return Key::of(&v);
        }
        if let Some(v) = m.core_dyn().row.as_ref().and_then(|r| r.extra.get(&c.key_name)) {
            return Key::of(v);
        }
    }
    Key::of_row(row, &asm.key).unwrap_or(Key::S(String::new()))
}

struct Loaded {
    items: Vec<(Key, Box<dyn AnyModel>)>,
    fetched: HashMap<Key, serde_json::Value>,
}

fn terminal(c: &Core) -> Result<Executor> {
    if c.group {
        return Err(config("a terminal is not allowed inside a group callback"));
    }
    if let Some(e) = c.err() {
        return Err(e);
    }
    resolve(&c.conn)
}

async fn load(c: &Core, kind: &str) -> Result<Loaded> {
    let ex = terminal(c)?;
    let mut req = build(c, kind);
    let res = select(&ex, &mut req).await?;
    assemble(c, &req, &res).await
}

async fn assemble(c: &Core, req: &Req, res: &QueryResult) -> Result<Loaded> {
    let asm = res.plan.steps[0].assemble.clone().expect("select plan has an assemble");
    let mut a = Assembler { res, conn: c.conn.clone() };
    let mut items = Vec::new();
    for row in &res.main {
        let built = a.model(c, &asm, row)?;
        let key = collection_key(c, built.model.as_ref(), &asm, row);
        items.push((key, built.model, built.builder));
    }
    let mut out: Vec<(Key, Box<dyn AnyModel>)> = Vec::new();
    for (key, mut model, builder) in items {
        if let Some(rels) = req.external.get(&builder) {
            for rel in rels {
                attach_external(std::slice::from_mut(&mut model), rel).await?;
            }
        }
        out.push((key, model));
    }
    let mut fetched = HashMap::new();
    if let Some(f) = &c.fetch_value {
        for (k, m) in &out {
            fetched.insert(k.clone(), f(m.as_ref()));
        }
    }
    Ok(Loaded { items: out, fetched })
}

fn value_key(v: &Option<Val>) -> String {
    match v {
        None | Some(Val::Null) => "\0".into(),
        Some(Val::Bool(b)) => (*b as i64).to_string(),
        Some(v) => v.as_string(),
    }
}

/// Runs a relation whose child has its own connection and attaches the rows.
async fn attach_external(parents: &mut [Box<dyn AnyModel>], rel: &RelSpec) -> Result<()> {
    let ch = &rel.child;
    let mut values = Vec::new();
    let mut seen = HashSet::new();
    let allowed = |p: &dyn AnyModel| match &ch.possible {
        Some((column, value)) => p.value_dyn(column).map(|v| same_scalar(&v, value)).unwrap_or(false),
        None => true,
    };
    for p in parents.iter() {
        if !allowed(p.as_ref()) {
            continue;
        }
        let v = p.value_dyn(&ch.match_left);
        if matches!(v, None | Some(Val::Null)) || !seen.insert(value_key(&v)) {
            continue;
        }
        values.push(val_param(v.as_ref().unwrap()));
    }
    let mut by_key: HashMap<String, Boxed> = HashMap::new();
    if !values.is_empty() {
        let mut q = (**ch).clone();
        q.match_left.clear();
        q.alias.clear();
        let pred = CondNode { conn: "", kind: CondKind::Pred(PredSpec { column: ch.match_right.clone(), op: "in", value: PredValue::List(values) }) };
        if q.where_.items.is_empty() {
            q.where_ = CondGroup { items: vec![pred], pending: "" };
        } else {
            let group = CondNode { conn: "", kind: CondKind::Group(std::mem::take(&mut q.where_.items)) };
            q.where_ = CondGroup { items: vec![group, CondNode { conn: "and", ..pred }], pending: "" };
        }
        let rows = Box::pin(load(&q, "all")).await?;
        for (k, m) in rows.items {
            let key = value_key(&m.value_dyn(&ch.match_right));
            let list = by_key.entry(key).or_default();
            if ch.group_limit > 0 && list.len() >= ch.group_limit as usize {
                continue;
            }
            list.push((k, m));
        }
    }
    let shared: HashMap<String, Shared> = by_key.into_iter().map(|(k, v)| (k, v.into_iter().map(|(key, m)| (key, Arc::from(m))).collect())).collect();
    let name = result_name(ch, rel.many);
    for p in parents.iter_mut() {
        let matched: Shared = if allowed(p.as_ref()) { shared.get(&value_key(&p.value_dyn(&ch.match_left))).cloned().unwrap_or_default() } else { Vec::new() };
        let st = p.core_dyn_mut().row.get_or_insert_with(RowState::default);
        if st.related.contains_key(&name) {
            return Err(config(format!("relation result name {name} is used twice")));
        }
        let value = if rel.many {
            let items: Vec<(Key, Box<dyn AnyModel>)> = matched.iter().map(|(k, m)| (k.clone(), clone_model(ch, m.as_ref()))).collect();
            RelatedValue::Many((ch.ent.collect)(items, HashMap::new()))
        } else {
            RelatedValue::One(matched.first().map(|(_, m)| m.clone()))
        };
        st.related.insert(name.clone(), Related { value, cascade: !ch.delete_lock, flat: !rel.many && ch.parent_node });
    }
    Ok(())
}

/// A copy of a loaded model with its field values.
fn clone_model(template: &Core, m: &dyn AnyModel) -> Box<dyn AnyModel> {
    let core = m.core_dyn().clone();
    let mut out = (template.ent.new)(core.clone());
    if let Some(row) = &core.row {
        for name in &row.names {
            if let Some(v) = m.value_dyn(name) {
                out.assign_dyn(name, v);
            }
        }
    }
    out
}

fn typed<M: Model>(m: Box<dyn AnyModel>) -> M {
    *m.into_any().downcast::<M>().expect("model type")
}

/// Runs the query and returns the first model; NO_ROWS when no row matches.
pub async fn get<M: Model>(m: &M) -> Result<M> {
    get_core(m.core()).await
}

pub async fn get_core<M: Model>(c: &Core) -> Result<M> {
    let rows = load(c, "one").await?;
    rows.items.into_iter().next().map(|(_, m)| typed(m)).ok_or(Error::NoRows)
}

/// Runs the query and returns the models.
pub async fn gets<M: Model>(m: &M) -> Result<Collection<M>> {
    gets_core(m.core(), "all").await
}

pub async fn gets_core<M: Model>(c: &Core, kind: &str) -> Result<Collection<M>> {
    let rows = load(c, kind).await?;
    Ok(Collection::from_boxes(rows.items, rows.fetched))
}

/// Runs a grouped count; each model carries row_count.
pub async fn gets_count<M: Model>(m: &M) -> Result<Collection<M>> {
    gets_core(m.core(), "group_count").await
}

/// Returns one page and the total count.
pub async fn gets_page<M: Model>(m: &M, page: u32, per_page: u32) -> Result<Page<M>> {
    let c = m.core();
    if page == 0 || per_page == 0 {
        return Err(config("gets_page requires a positive page and per_page"));
    }
    if c.limit.is_some() {
        return Err(config("gets_page cannot be combined with limit"));
    }
    let ex = terminal(c)?;
    let mut q = c.clone();
    q.limit = Some(((page - 1) * per_page, per_page));
    let mut req = build(&q, "paginate");
    let db = ex.db().clone();
    let res = select(&ex, &mut req).await?;
    let count = res.plan.steps.iter().find(|s| s.role == "count").ok_or_else(|| Error::internal("paginate plan has no count step"))?.clone();
    let rows = ex.query(&count, &req.params, Vec::new()).await?;
    let total = first_cell(&rows, ex.db().inner.zone)?.as_i64();
    let loaded = assemble(&q, &req, &res).await?;
    let _ = db;
    Ok(Page {
        items: Collection::from_boxes(loaded.items, loaded.fetched),
        total_count: total,
        total_pages: (total + per_page as i64 - 1) / per_page as i64,
        page,
        per_page,
    })
}

async fn scalar(c: &Core, kind: &str) -> Result<Val> {
    let ex = terminal(c)?;
    let mut req = build(c, kind);
    if kind == "sum" || kind == "avg" {
        req.ir.agg = c.agg.clone();
    }
    let db = ex.db().clone();
    let plan = db.plan(&mut req).await?;
    let st = &plan.steps[0];
    let parts = root_in_parts(&req, st.bind_slots.len(), db.driver())?;
    if !parts.is_empty() {
        if kind != "count" {
            return Err(Error::Engine { code: codes::IR_INVALID.into(), msg: "a split IN list can be merged only for a count".into() });
        }
        let mut total = 0;
        for mut part in parts {
            let pp = db.plan(&mut part).await?;
            let rows = ex.query(&pp.steps[0], &part.params, Vec::new()).await?;
            total += first_cell(&rows, ex.db().inner.zone)?.as_i64();
        }
        return Ok(Val::I64(total));
    }
    let rows = ex.query(st, &req.params, Vec::new()).await?;
    first_cell(&rows, ex.db().inner.zone)
}

/// The number of matching rows.
pub async fn get_count(c: &Core) -> Result<i64> {
    Ok(scalar(c, "count").await?.as_i64())
}

/// The sum of the column selected with sum_<col>().
pub async fn get_sum(c: &Core) -> Result<f64> {
    if c.agg_fn != "sum" {
        return Err(config("get_sum requires sum_<col>()"));
    }
    Ok(scalar(c, "sum").await?.as_f64())
}

/// The average of the column selected with avg_<col>().
pub async fn get_avg(c: &Core) -> Result<f64> {
    if c.agg_fn != "avg" {
        return Err(config("get_avg requires avg_<col>()"));
    }
    Ok(scalar(c, "avg").await?.as_f64())
}

/// The statement of gets() without executing it.
pub async fn get_query(c: &Core) -> Result<Statement> {
    let ex = terminal(c)?;
    let mut req = build(c, "all");
    ex.db().statement(&mut req).await
}

// ---- writes ----

pub(crate) async fn in_transaction<T>(conn: &Option<Db>, f: impl AsyncFn() -> Result<T>) -> Result<T> {
    match conn {
        Some(db) => db.transaction(f).retry(0).await,
        None => {
            resolve(&None)?;
            f().await
        }
    }
}

fn write_req(c: &Core, kind: &str) -> Req {
    Req::new(c.ent.schema, kind, c.ent.name)
}

fn encode(ent: &EntitySchema, column: &str, v: &serde_json::Value) -> Result<Param> {
    let col = ent.column(column).ok_or_else(|| Error::Engine { code: codes::COLUMN_UNKNOWN.into(), msg: format!("{}.{column}", ent.name) })?;
    crate::codec::encode(&col.codec_styles(), Some(v))
}

fn encode_ordered(ent: &EntitySchema, column: &str, v: &ordered_json::Value) -> Result<Param> {
    let col = ent.column(column).ok_or_else(|| Error::Engine { code: codes::COLUMN_UNKNOWN.into(), msg: format!("{}.{column}", ent.name) })?;
    crate::codec::encode_ordered(&col.codec_styles(), v)
}

fn assign(r: &mut Req, ent: &EntitySchema, s: &SetSpec) -> Result<ir::Assign> {
    let mut a = ir::Assign { column: s.column.clone(), ..Default::default() };
    match &s.value {
        SetValue::Null => a.null = true,
        SetValue::Value(v) => a.p = Some(r.p(v.clone())),
        SetValue::Json(v) => match encode(ent, &s.column, v)? {
            Param::Null => a.null = true,
            p => a.p = Some(r.p(p)),
        },
        SetValue::Ordered(v) => match encode_ordered(ent, &s.column, v)? {
            Param::Null => a.null = true,
            p => a.p = Some(r.p(p)),
        },
        SetValue::Raw(raw) => {
            a.expr = raw.sql.clone();
            a.ps = raw.binds.iter().map(|b| r.p(b.clone())).collect();
        }
        SetValue::Plus(n) => a.plus_p = Some(r.p(n.clone())),
        SetValue::Minus(n) => a.minus_p = Some(r.p(n.clone())),
    }
    Ok(a)
}

async fn write(ex: &Executor, req: &mut Req) -> Result<(u64, u64)> {
    let db = ex.db().clone();
    let plan = db.plan(req).await?;
    let st = &plan.steps[0];
    if req.ir.kind == "insert" && st.sql.contains(" RETURNING ") {
        let rows = ex.query(st, &req.params, Vec::new()).await?;
        return Ok((first_cell(&rows, ex.db().inner.zone)?.as_i64() as u64, 1));
    }
    let (id, affected) = ex.execute(st, &req.params).await?;
    if req.ir.kind == "update" && req.ir.optimistic.is_some() && affected == 0 {
        return Err(Error::OptimisticLock);
    }
    Ok((id, affected))
}

/// Inserts the model and returns the created model.
pub async fn create<M: Model>(m: &mut M) -> Result<M> {
    let c = m.core();
    let ex = terminal(c)?;
    if c.sets.is_empty() {
        return Err(config("create requires set_<col> values"));
    }
    let ent = c.ent.entity_schema()?;
    let mut req = write_req(c, "insert");
    for s in &c.sets {
        let a = assign(&mut req, &ent, s)?;
        req.ir.set.push(a);
    }
    if let Some(dup) = &c.duplication {
        for s in &dup.sets {
            let a = assign(&mut req, &ent, s)?;
            req.ir.on_duplicate.push(a);
        }
        if req.ir.on_duplicate.is_empty() {
            return Err(config("duplication model has no set_<col> values"));
        }
    }
    req.ir.n_params = req.params.len();
    let (id, _) = write(&ex, &mut req).await?;
    let mut out = M::from_core(Core::new(c.ent));
    let mut st = RowState::default();
    for s in &c.sets {
        st.add_name(&s.column);
        match &s.value {
            SetValue::Value(v) => {
                out.assign(&s.column, param_val(v));
            }
            SetValue::Json(v) => {
                out.assign(&s.column, Val::Json(v.clone()));
            }
            SetValue::Ordered(v) => {
                out.assign(&s.column, Val::Ordered(v.clone()));
            }
            SetValue::Null => {
                out.assign(&s.column, Val::Null);
            }
            _ => {}
        }
    }
    if !ent.auto.is_empty() {
        st.add_name(&ent.auto);
        out.assign(&ent.auto, Val::I64(id as i64));
    }
    st.loaded = true;
    for pk in &ent.pk {
        match out.value(pk) {
            Some(v) if !matches!(v, Val::Null) && !(matches!(v, Val::I64(0))) && !(matches!(&v, Val::Str(s) if s.is_empty())) => {
                st.original.insert(pk.clone(), val_param(&v));
            }
            _ => st.loaded = false,
        }
    }
    let news = c.news.clone();
    let conn = c.conn.clone();
    let core = out.core_mut();
    core.conn = conn;
    core.news = news;
    core.row = Some(st);
    let c = m.core_mut();
    c.sets.clear();
    c.duplication = None;
    Ok(out)
}

/// Inserts models in multi-row statements in one transaction and returns the
/// inserted row count.
pub async fn creates<M: Model>(m: &M, rows: Vec<M>) -> Result<u64> {
    let c = m.core();
    let ex = terminal(c)?;
    if rows.is_empty() {
        return Ok(0);
    }
    let ent = c.ent.entity_schema()?;
    let first = rows[0].core();
    if first.sets.is_empty() {
        return Err(config("creates requires models with set_<col> values"));
    }
    let columns: Vec<String> = first.sets.iter().map(|s| s.column.clone()).collect();
    let per = (bind_limit(ex.db().driver()) / columns.len()).max(1);
    in_transaction(&c.conn, async || {
        let mut total = 0;
        for chunk in rows.chunks(per) {
            let mut req = write_req(c, "insert");
            for (i, row) in chunk.iter().enumerate() {
                let rc = row.core();
                if rc.sets.len() != columns.len() {
                    return Err(config("every model of creates must set the same columns"));
                }
                let mut params = Vec::new();
                for (s, column) in rc.sets.iter().zip(&columns) {
                    if &s.column != column {
                        return Err(config("every model of creates must set the same columns in the same order"));
                    }
                    let v = match &s.value {
                        SetValue::Value(v) => v.clone(),
                        SetValue::Null => Param::Null,
                        SetValue::Json(v) => encode(&ent, &s.column, v)?,
                        SetValue::Ordered(v) => encode_ordered(&ent, &s.column, v)?,
                        _ => return Err(config("creates accepts stored values only")),
                    };
                    let p = req.p(v);
                    if i == 0 {
                        req.ir.set.push(ir::Assign { column: column.clone(), p: Some(p), ..Default::default() });
                    } else {
                        params.push(p);
                    }
                }
                if i > 0 {
                    req.ir.rows.push(params);
                }
            }
            req.ir.n_params = req.params.len();
            let inner = resolve(&c.conn)?;
            let (_, n) = write(&inner, &mut req).await?;
            total += n;
        }
        Ok(total)
    })
    .await
}

fn key_values(c: &Core, ent: &EntitySchema) -> Result<HashMap<String, Param>> {
    let mut keys = HashMap::new();
    let loaded = c.row.as_ref().map(|r| r.loaded).unwrap_or(false);
    for pk in &ent.pk {
        if loaded {
            if let Some(v) = c.row.as_ref().unwrap().original.get(pk) {
                keys.insert(pk.clone(), v.clone());
                continue;
            }
        }
        let found = c.sets.iter().find(|s| &s.column == pk).and_then(|s| match &s.value {
            SetValue::Value(v) => Some(v.clone()),
            _ => None,
        });
        match found {
            Some(v) => {
                keys.insert(pk.clone(), v);
            }
            None => return Err(config(format!("{} requires a loaded row or a set primary key {pk}", ent.name))),
        }
    }
    Ok(keys)
}

fn key_where(req: &mut Req, ent: &EntitySchema, keys: &HashMap<String, Param>) {
    let mut g = ir::Group::default();
    for (i, pk) in ent.pk.iter().enumerate() {
        let p = req.p(keys[pk].clone());
        g.items.push(ir::Item::Pred {
            pred: Box::new(ir::Pred {
                conn: if i > 0 { "and".into() } else { String::new() },
                column: pk.clone(),
                op: "eq".into(),
                p: Some(p),
                ..Default::default()
            }),
        });
    }
    req.ir.query.where_ = Some(g);
}

/// The sets of an update plus the other AES columns of the row when one AES
/// column changes, so every AES column is written with the same key version.
fn with_aes_columns<M: Model>(m: &M, ent: &EntitySchema) -> Result<Vec<SetSpec>> {
    let c = m.core();
    let mut sets = c.sets.clone();
    if ent.aes_version.is_empty() {
        return Ok(sets);
    }
    let changed = c.sets.iter().any(|s| ent.column(&s.column).map(|col| col.is_aes()).unwrap_or(false));
    if !changed {
        return Ok(sets);
    }
    for col in &ent.columns {
        if !col.is_aes() || c.sets.iter().any(|s| s.column == col.name) {
            continue;
        }
        let loaded = c.row.as_ref().map(|r| r.names.iter().any(|n| n == &col.name)).unwrap_or(false);
        if !loaded {
            return Err(config(format!("changing an AES column of {} requires a row loaded with {}", ent.name, col.name)));
        }
        let v = m.value(&col.name).unwrap_or(Val::Null);
        let value = match v {
            Val::Null => SetValue::Null,
            Val::Ordered(o) => SetValue::Ordered(o),
            Val::Json(j) => SetValue::Json(j),
            other => SetValue::Value(val_param(&other)),
        };
        sets.push(SetSpec { column: col.name.clone(), value });
    }
    Ok(sets)
}

/// Writes the changed columns. `update(true)` also requires the stored update
/// time to equal the value that was read.
pub async fn update<M: Model>(m: &mut M, optimistic: bool) -> Result<()> {
    let ex = terminal(m.core())?;
    let c = m.core();
    let ent = c.ent.entity_schema()?;
    let mut req = write_req(c, "update");
    let keys = key_values(c, &ent)?;
    let loaded = c.row.as_ref().map(|r| r.loaded).unwrap_or(false);
    for s in with_aes_columns(m, &ent)? {
        if !loaded && ent.pk.contains(&s.column) {
            continue;
        }
        let a = assign(&mut req, &ent, &s)?;
        req.ir.set.push(a);
    }
    if req.ir.set.is_empty() {
        return Ok(());
    }
    key_where(&mut req, &ent, &keys);
    let column = ent.updated_column().to_owned();
    if optimistic {
        let version = c.row.as_ref().filter(|_| loaded && !column.is_empty()).and_then(|r| r.original.get(&column)).cloned();
        let Some(version) = version else {
            return Err(config("update(true) requires a row loaded with its update time column"));
        };
        let p = req.p(version);
        req.ir.optimistic = Some(ir::Optimist { column: column.clone(), p });
    }
    req.ir.n_params = req.params.len();
    write(&ex, &mut req).await?;
    let c = m.core_mut();
    if loaded {
        let changes: Vec<(String, Param)> = c
            .sets
            .iter()
            .filter(|s| ent.pk.contains(&s.column))
            .filter_map(|s| match &s.value {
                SetValue::Value(v) => Some((s.column.clone(), v.clone())),
                _ => None,
            })
            .collect();
        if let Some(row) = c.row.as_mut() {
            for (k, v) in changes {
                row.original.insert(k, v);
            }
            row.original.remove(&column);
        }
    }
    c.sets.clear();
    Ok(())
}

/// Updates the row when its primary key is known, otherwise creates it.
pub async fn save<M: Model>(m: &mut M) -> Result<M> {
    terminal(m.core())?;
    let ent = m.core().ent.entity_schema()?;
    if key_values(m.core(), &ent).is_ok() {
        update(m, false).await?;
        return Ok(m.clone());
    }
    create(m).await
}

/// Deletes the row; `delete(true)` first deletes loaded related rows that
/// belong to it, except relations marked with delete_lock.
pub async fn delete<M: Model>(m: &M, recursive: bool) -> Result<()> {
    terminal(m.core())?;
    if recursive {
        let conn = m.core().conn.clone();
        return in_transaction(&conn, async || delete_row(m, true).await).await;
    }
    delete_row(m, false).await
}

pub(crate) async fn delete_row(m: &dyn AnyModel, recursive: bool) -> Result<()> {
    let c = m.core_dyn();
    let ex = terminal(c)?;
    if recursive {
        if let Some(row) = &c.row {
            for rel in row.related.values() {
                if !rel.cascade {
                    continue;
                }
                match &rel.value {
                    RelatedValue::One(Some(child)) => Box::pin(delete_row(child.as_ref(), true)).await?,
                    RelatedValue::One(None) => {}
                    RelatedValue::Many(coll) => {
                        for child in coll.models_dyn() {
                            Box::pin(delete_row(child, true)).await?;
                        }
                    }
                }
            }
        }
    }
    let ent = c.ent.entity_schema()?;
    let mut req = write_req(c, "delete");
    let keys = key_values(c, &ent)?;
    key_where(&mut req, &ent, &keys);
    req.ir.n_params = req.params.len();
    write(&ex, &mut req).await?;
    Ok(())
}

// ---- array and JSON output ----

/// The row values: columns, added outputs, attached values, and relation
/// results. Relations merged with parent_node add their columns where the row
/// has no value of the same name. A value that serde_json cannot represent
/// returns CODEC_ENCODE.
pub fn to_array(m: &dyn AnyModel) -> Result<serde_json::Value> {
    let c = m.core_dyn();
    let mut out = serde_json::Map::new();
    let empty = RowState::default();
    let st = c.row.as_ref().unwrap_or(&empty);
    let mut names = st.names.clone();
    if c.row.is_none() {
        names = c.sets.iter().map(|s| s.column.clone()).collect();
    }
    for name in &names {
        if st.hidden.contains(name) {
            continue;
        }
        let v = match m.value_dyn(name) {
            Some(v) => v,
            None => st.extra.get(name).cloned().unwrap_or(Val::Null),
        };
        out.insert(name.clone(), v.to_json()?);
    }
    for (name, v) in &c.news {
        out.entry(name.clone()).or_insert_with(|| v.clone());
    }
    for (name, rel) in &st.related {
        let v = match &rel.value {
            RelatedValue::One(None) => serde_json::Value::Null,
            RelatedValue::One(Some(child)) => to_array(child.as_ref())?,
            RelatedValue::Many(coll) => coll.to_array_dyn()?,
        };
        out.entry(name.clone()).or_insert(v);
    }
    for rel in st.related.values() {
        if let (true, RelatedValue::One(Some(child))) = (rel.flat, &rel.value) {
            if let serde_json::Value::Object(fields) = to_array(child.as_ref())? {
                for (k, v) in fields {
                    out.entry(k).or_insert(v);
                }
            }
        }
    }
    Ok(serde_json::Value::Object(out))
}
