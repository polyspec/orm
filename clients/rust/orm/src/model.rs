//! Generated models: the traits they implement, assembly of rows into models,
//! terminals, and writes.

use std::any::Any;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;

use indexmap::IndexMap;

use crate::collection::{AnyCollection, Collection, GroupRow, GroupRows, Key, Page};
use crate::core::{config, CondGroup, CondKind, CondNode, Core, PredSpec, PredValue, RelSpec, SetSpec, SetValue};
use crate::db::{Db, Executor, Statement};
use crate::driver::{child_keys, first_cell, parent_values, positional, relation_chunks, same_scalar};
use crate::ir;
use crate::plan::{Assemble, Plan};
use crate::request::{build, result_name, Req};
use crate::schema::Schema;
use crate::tx::resolve;
use crate::value::{Param, Val};
use crate::{codes, Error, Result};
use polyspec_orm_schema::dbspec;

/// Implemented by every generated model.
pub trait Model: Clone + Send + Sync + 'static {
    fn entity() -> &'static Entity;
    fn core(&self) -> &Core;
    fn core_mut(&mut self) -> &mut Core;
    fn from_core(core: Core) -> Self;
    fn into_core(self) -> Core;
    /// Stores a decoded column value; false when name is not a column.
    fn assign(&mut self, name: &str, value: Val) -> Result<bool>;
    /// Reads a column value; None when name is not a column.
    fn value(&self, name: &str) -> Option<Val>;
}

/// A model seen without its type.
pub trait AnyModel: Any + Send + Sync {
    fn core_dyn(&self) -> &Core;
    fn core_dyn_mut(&mut self) -> &mut Core;
    fn assign_dyn(&mut self, name: &str, value: Val) -> Result<bool>;
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
    fn assign_dyn(&mut self, name: &str, value: Val) -> Result<bool> {
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
    /// runtime model의 entity.
    pub fn entity_schema(&self) -> Result<dbspec::Entity> {
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
    /// The related row of a relation or join result. A row without the result
    /// or without a related row is `None`; a stored value of another model type
    /// or a collection is `INTERNAL`.
    pub fn related_one<M: Model>(&self, name: &str) -> Result<Option<&M>> {
        let Some(related) = self.row.as_ref().and_then(|r| r.related.get(name)) else { return Ok(None) };
        match &related.value {
            RelatedValue::One(None) => Ok(None),
            // 다른 model type을 None으로 버리지 않고 보고한다.
            RelatedValue::One(Some(m)) => {
                m.as_any().downcast_ref::<M>().map(Some).ok_or_else(|| related_mismatch::<M>(name, &format!("a row of {}", m.core_dyn().ent.name)))
            }
            RelatedValue::Many(_) => Err(related_mismatch::<M>(name, "a collection")),
        }
    }

    /// The related rows of a relation result. A row without the result is
    /// `None`; a stored collection of another model type or a single row is
    /// `INTERNAL`.
    pub fn related_many<M: Model>(&self, name: &str) -> Result<Option<&Collection<M>>> {
        let Some(related) = self.row.as_ref().and_then(|r| r.related.get(name)) else { return Ok(None) };
        match &related.value {
            RelatedValue::Many(c) => {
                c.as_any().downcast_ref::<Collection<M>>().map(Some).ok_or_else(|| related_mismatch::<Collection<M>>(name, "a collection of another model"))
            }
            RelatedValue::One(_) => Err(related_mismatch::<Collection<M>>(name, "a single row")),
        }
    }
}

/// relation result name에 저장된 값이 요청한 type T와 다를 때의 INTERNAL error.
fn related_mismatch<T>(name: &str, stored: &str) -> Error {
    Error::internal(format!("relation result {name} holds {stored}, not {}", std::any::type_name::<T>()))
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
    fn related(&self, ch: &crate::plan::Child, parent: &[Val]) -> Result<Vec<&[Val]>> {
        let Some(sr) = self.steps.get(&ch.step) else { return Ok(Vec::new()) };
        let st = &self.plan.steps[ch.step as usize];
        if let Some(ifp) = st.parent.as_ref().and_then(|p| p.if_parent.as_ref()) {
            if !same_scalar(&parent[ifp.index], &self.params[ifp.param])? {
                return Ok(Vec::new());
            }
        }
        let Some(key) = Key::of_row(parent, &ch.parent_keys)? else { return Ok(Vec::new()) };
        Ok(match sr.by_key.get(&key) {
            Some(idxs) => idxs.iter().map(|&i| sr.data[i].as_slice()).collect(),
            None => Vec::new(),
        })
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
    if q.limit.is_some() || !q.order.is_empty() || !q.group_by.is_empty() {
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
                if seen.insert(Key::of_row(&row, &pasm.key)?) {
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
            parent_values(pr, out.main.iter().map(Vec::as_slice), &req.params)?
        } else {
            parent_values(pr, out.steps[&pr.step].data.iter().map(Vec::as_slice), &req.params)?
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
                if let Some(key) = Key::of_row(row, &keys)? {
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
            if !col.column.is_empty()
                && col.column == col.name
                && m.assign_dyn(&col.name, v.clone()).map_err(|error| column_decode_error(b.ent.name, &col.name, error))?
            {
                continue;
            }
            st.extra.insert(col.name.clone(), v);
        }
        for key in &asm.key {
            let name = asm.columns.iter().find(|c| c.index == key.index).ok_or_else(|| Error::internal("key column index is missing"))?.name.clone();
            let value = m.value_dyn(&name).or_else(|| st.extra.get(&name).cloned()).ok_or_else(|| Error::internal(format!("key column {name} is missing")))?;
            st.original.insert(name, val_param(&value));
        }
        let ent = b.ent.entity_schema()?;
        let updated = ent.updated.as_deref().unwrap_or("");
        if !updated.is_empty() && st.names.iter().any(|n| n == updated) {
            let value = m
                .value_dyn(updated)
                .or_else(|| st.extra.get(updated).cloned())
                .ok_or_else(|| Error::internal(format!("updated column {updated} is missing")))?;
            st.original.insert(updated.to_owned(), val_param(&value));
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
            let rows: Vec<Vec<Val>> = self.res.related(ch, row)?.into_iter().map(|r| r.to_vec()).collect();
            let casm = self.res.plan.steps[ch.step as usize].assemble.clone().expect("relation step has an assemble");
            if many {
                let mut items = Vec::new();
                for cr in &rows {
                    let built = self.model(child, &casm, cr)?;
                    let key = collection_key(child, built.model.as_ref(), &casm, cr)?;
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

fn column_decode_error(entity: &str, column: &str, error: Error) -> Error {
    match error {
        Error::Engine { code, msg } if code == codes::CODEC_DECODE => Error::Engine { code, msg: format!("{entity}.{column}: {msg}") },
        other => other,
    }
}

fn collection_key(c: &Core, m: &dyn AnyModel, asm: &Assemble, row: &[Val]) -> Result<Key> {
    if let Some(f) = &c.fetch_key {
        return Ok(f(m));
    }
    if !c.key_name.is_empty() {
        if let Some(v) = m.value_dyn(&c.key_name) {
            return Key::of(&v);
        }
        if let Some(v) = m.core_dyn().row.as_ref().and_then(|r| r.extra.get(&c.key_name)) {
            return Key::of(v);
        }
    }
    Key::of_row(row, &asm.key)?.ok_or_else(|| Error::internal("selected row has no collection key"))
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
        let key = collection_key(c, built.model.as_ref(), &asm, row)?;
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

fn value_key(v: &Option<Val>) -> Result<String> {
    Ok(match v {
        None | Some(Val::Null) => "\0".into(),
        Some(Val::Bool(b)) => (*b as i64).to_string(),
        Some(v) => v.as_string()?,
    })
}

/// model의 relation key 성분 값을 key 순서로 반환한다. 부모 쪽은 `child`가 false,
/// 자식 쪽은 true다. 성분 하나라도 null이면 None이다.
fn match_values(m: &dyn AnyModel, ch: &Core, child: bool) -> Option<Vec<Val>> {
    ch.matches
        .iter()
        .map(|&(left, right)| match m.value_dyn(if child { right } else { left }) {
            None | Some(Val::Null) => None,
            Some(v) => Some(v),
        })
        .collect()
}

/// relation key 성분 값의 key. 성분 하나는 그 값의 key이고, composite key는 성분 key를 길이와 함께 잇는다.
fn match_key(values: &[Val]) -> Result<String> {
    if let [v] = values {
        return value_key(&Some(v.clone()));
    }
    let mut out = String::new();
    for v in values {
        let part = value_key(&Some(v.clone()))?;
        out.push_str(&format!("{}:{part}", part.len()));
    }
    Ok(out)
}

/// Runs a relation whose child has its own connection and attaches the rows.
async fn attach_external(parents: &mut [Box<dyn AnyModel>], rel: &RelSpec) -> Result<()> {
    let ch = &rel.child;
    let mut values = Vec::new();
    let mut seen = HashSet::new();
    let allowed = |p: &dyn AnyModel| -> Result<bool> {
        match &ch.possible {
            Some((column, value)) => match p.value_dyn(column) {
                Some(v) => same_scalar(&v, value),
                None => Ok(false),
            },
            None => Ok(true),
        }
    };
    for p in parents.iter() {
        if !allowed(p.as_ref())? {
            continue;
        }
        let Some(v) = match_values(p.as_ref(), ch, false) else { continue };
        if !seen.insert(match_key(&v)?) {
            continue;
        }
        values.push(v.iter().map(val_param).collect::<Vec<_>>());
    }
    let mut by_key: HashMap<String, Boxed> = HashMap::new();
    if !values.is_empty() {
        let mut q = (**ch).clone();
        q.matches.clear();
        q.alias.clear();
        let rights: Vec<&'static str> = ch.matches.iter().map(|&(_, right)| right).collect();
        // composite key는 자식 key column 전체를 tuple로 거른다.
        let spec = if rights.len() == 1 {
            PredSpec { column: rights[0].into(), op: "in", value: PredValue::List(values.into_iter().flatten().collect()) }
        } else {
            PredSpec { column: String::new(), op: "tuple_in", value: PredValue::Tuples(rights, values) }
        };
        let pred = CondNode { conn: "", kind: CondKind::Pred(spec) };
        if q.where_.items.is_empty() {
            q.where_ = CondGroup { items: vec![pred], pending: "" };
        } else {
            let group = CondNode { conn: "", kind: CondKind::Group(std::mem::take(&mut q.where_.items), false) };
            q.where_ = CondGroup { items: vec![group, CondNode { conn: "and", ..pred }], pending: "" };
        }
        let rows = Box::pin(load(&q, "all")).await?;
        for (k, m) in rows.items {
            let Some(v) = match_values(m.as_ref(), ch, true) else { continue };
            let key = match_key(&v)?;
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
        let matched: Shared = match (allowed(p.as_ref())?, match_values(p.as_ref(), ch, false)) {
            (true, Some(v)) => shared.get(&match_key(&v)?).cloned().unwrap_or_default(),
            _ => Vec::new(),
        };
        let st = p.core_dyn_mut().row.get_or_insert_with(RowState::default);
        if st.related.contains_key(&name) {
            return Err(config(format!("relation result name {name} is used twice")));
        }
        let value = if rel.many {
            let items: Vec<(Key, Box<dyn AnyModel>)> = matched.iter().map(|(k, m)| Ok((k.clone(), clone_model(ch, m.as_ref())?))).collect::<Result<_>>()?;
            RelatedValue::Many((ch.ent.collect)(items, HashMap::new()))
        } else {
            RelatedValue::One(matched.first().map(|(_, m)| m.clone()))
        };
        st.related.insert(name.clone(), Related { value, cascade: !ch.delete_lock, flat: !rel.many && ch.parent_node });
    }
    Ok(())
}

/// A copy of a loaded model with its field values.
fn clone_model(template: &Core, m: &dyn AnyModel) -> Result<Box<dyn AnyModel>> {
    let core = m.core_dyn().clone();
    let mut out = (template.ent.new)(core.clone());
    if let Some(row) = &core.row {
        for name in &row.names {
            if let Some(v) = m.value_dyn(name) {
                // Selected expressions live in the cloned Core row, not a model field.
                out.assign_dyn(name, v)?;
            }
        }
    }
    Ok(out)
}

fn assign_model<M: Model>(model: &mut M, name: &str, value: Val) -> Result<()> {
    if model.assign(name, value)? {
        Ok(())
    } else {
        Err(Error::internal(format!("model has no column {name}")))
    }
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

/// Runs a grouped count and returns only grouping values and row counts.
pub async fn gets_count<M: Model>(m: &M) -> Result<GroupRows> {
    let ex = terminal(m.core())?;
    let mut request = build(m.core(), "group_count");
    let result = select(&ex, &mut request).await?;
    let columns = &result.plan.steps[0].assemble.as_ref().ok_or_else(|| Error::internal("group count has no assemble"))?.columns;
    let mut groups = Vec::with_capacity(result.main.len());
    for row in &result.main {
        let mut values = Vec::with_capacity(columns.len());
        for column in columns {
            if !column.hidden {
                values.push((column.name.clone(), row.get(column.index).cloned().ok_or_else(|| Error::internal("group result column is missing"))?));
            }
        }
        groups.push(GroupRow::new(values)?);
    }
    Ok(GroupRows::new(groups))
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
    let offset = (page - 1).checked_mul(per_page).ok_or_else(|| config("page offset exceeds u32 range"))?;
    q.limit = Some((offset, per_page));
    let mut req = build(&q, "paginate");
    let db = ex.db().clone();
    let res = select(&ex, &mut req).await?;
    let count = res.plan.steps.iter().find(|s| s.role == "count").ok_or_else(|| Error::internal("paginate plan has no count step"))?.clone();
    let rows = ex.query(&count, &req.params, Vec::new()).await?;
    let total = first_cell(&rows, ex.db().inner.zone)?.as_i64()?;
    if total < 0 {
        return Err(Error::internal("negative row count"));
    }
    let loaded = assemble(&q, &req, &res).await?;
    let _ = db;
    Ok(Page {
        items: Collection::from_boxes(loaded.items, loaded.fetched),
        total_count: total,
        total_pages: total / per_page as i64 + i64::from(total % per_page as i64 != 0),
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
        let mut total: i64 = 0;
        for mut part in parts {
            let pp = db.plan(&mut part).await?;
            let rows = ex.query(&pp.steps[0], &part.params, Vec::new()).await?;
            total = total.checked_add(first_cell(&rows, ex.db().inner.zone)?.as_i64()?).ok_or_else(|| Error::internal("row count exceeds i64 range"))?;
        }
        return Ok(Val::I64(total));
    }
    let rows = ex.query(st, &req.params, Vec::new()).await?;
    first_cell(&rows, ex.db().inner.zone)
}

/// The number of matching rows.
pub async fn get_count(c: &Core) -> Result<i64> {
    let count = scalar(c, "count").await?.as_i64()?;
    if count < 0 {
        return Err(Error::internal("negative row count"));
    }
    Ok(count)
}

/// The sum of the column selected with sum_<col>().
pub async fn get_sum(c: &Core) -> Result<f64> {
    if c.agg_fn != "sum" {
        return Err(config("get_sum requires sum_<col>()"));
    }
    scalar(c, "sum").await?.as_aggregate_f64()
}

/// The average of the column selected with avg_<col>().
pub async fn get_avg(c: &Core) -> Result<f64> {
    if c.agg_fn != "avg" {
        return Err(config("get_avg requires avg_<col>()"));
    }
    scalar(c, "avg").await?.as_aggregate_f64()
}

/// The statement of gets() without executing it.
pub async fn get_query(c: &Core) -> Result<Statement> {
    let ex = terminal(c)?;
    let mut req = build(c, "all");
    ex.db().statement(&mut req).await
}

// ---- writes ----

pub(crate) async fn in_transaction<T, F, Fut>(conn: &Option<Db>, f: F) -> Result<T>
where
    F: Fn() -> Fut + Send + Sync,
    Fut: Future<Output = Result<T>> + Send,
    T: Send,
{
    match conn {
        Some(db) => db.transaction_send(f).retry(0).await,
        None => {
            resolve(&None)?;
            f().await
        }
    }
}

fn write_req(c: &Core, kind: &str) -> Req {
    Req::new(c.ent.schema, kind, c.ent.name)
}

fn encode(ent: &dbspec::Entity, column: &str, v: &serde_json::Value) -> Result<Param> {
    let col = ent.field(column).ok_or_else(|| Error::Engine { code: codes::COLUMN_UNKNOWN.into(), msg: format!("{}.{column}", ent.name) })?;
    crate::codec::encode(&crate::codec::executor_stages(&col.codec), crate::StyledValue::Value(v))
}

fn encode_ordered(ent: &dbspec::Entity, column: &str, v: &ordered_json::Value) -> Result<Param> {
    let col = ent.field(column).ok_or_else(|| Error::Engine { code: codes::COLUMN_UNKNOWN.into(), msg: format!("{}.{column}", ent.name) })?;
    crate::codec::encode_ordered(&crate::codec::executor_stages(&col.codec), crate::StyledValue::Value(v))
}

fn assign(r: &mut Req, ent: &dbspec::Entity, s: &SetSpec) -> Result<ir::Assign> {
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
        return Ok((u64::try_from(first_cell(&rows, ex.db().inner.zone)?.as_i64()?).map_err(|_| Error::internal("negative row count"))?, 1));
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
                assign_model(&mut out, &s.column, param_val(v))?;
            }
            SetValue::Json(v) => {
                assign_model(&mut out, &s.column, Val::Json(v.clone()))?;
            }
            SetValue::Ordered(v) => {
                assign_model(&mut out, &s.column, Val::Ordered(v.clone()))?;
            }
            SetValue::Null => {
                assign_model(&mut out, &s.column, Val::Null)?;
            }
            _ => {}
        }
    }
    if let Some(identity) = &ent.identity {
        st.add_name(identity);
        let id = i64::try_from(id).map_err(|_| Error::internal("generated id is outside i64 range"))?;
        assign_model(&mut out, identity, Val::I64(id))?;
    }
    st.loaded = true;
    for pk in &ent.primary_key {
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

fn key_values(c: &Core, ent: &dbspec::Entity) -> Result<HashMap<String, Param>> {
    let mut keys = HashMap::new();
    let loaded = c.row.as_ref().map(|r| r.loaded).unwrap_or(false);
    for pk in &ent.primary_key {
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

fn key_where(req: &mut Req, ent: &dbspec::Entity, keys: &HashMap<String, Param>) {
    let mut g = ir::Group::default();
    for (i, pk) in ent.primary_key.iter().enumerate() {
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
fn with_aes_columns<M: Model>(m: &M, ent: &dbspec::Entity) -> Result<Vec<SetSpec>> {
    let c = m.core();
    let mut sets = c.sets.clone();
    if ent.aes_version.is_none() {
        return Ok(sets);
    }
    let changed = c.sets.iter().any(|s| ent.field(&s.column).map(|col| col.aes()).unwrap_or(false));
    if !changed {
        return Ok(sets);
    }
    for col in &ent.fields {
        if !col.aes() || c.sets.iter().any(|s| s.column == col.name) {
            continue;
        }
        let loaded = c.row.as_ref().map(|r| r.names.iter().any(|n| n == &col.name)).unwrap_or(false);
        if !loaded {
            return Err(config(format!("changing an AES column of {} requires a row loaded with {}", ent.name, col.name)));
        }
        let v = m.value(&col.name).ok_or_else(|| Error::internal(format!("model has no column {}", col.name)))?;
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
        if !loaded && ent.primary_key.contains(&s.column) {
            continue;
        }
        let a = assign(&mut req, &ent, &s)?;
        req.ir.set.push(a);
    }
    if req.ir.set.is_empty() {
        return Ok(());
    }
    key_where(&mut req, &ent, &keys);
    let column = ent.updated.clone().unwrap_or_default();
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
            .filter(|s| ent.primary_key.contains(&s.column))
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

/// transaction의 audit 기록을 `ex`에서 삽입하고 그 table과 primary key 값을 돌려준다. 기록 table의 entity에
/// 대한 insert request이며, primary key가 identity면 생성된 key, 아니면 기록의 값이다.
pub(crate) async fn insert_audit(ex: &Executor, a: &crate::tx::AuditInsert) -> Result<crate::tx::AuditKey> {
    let ent = &a.entity;
    let mut req = Req::new(a.schema, "insert", &ent.name);
    for (column, value) in &a.values {
        let spec = SetSpec { column: column.clone(), value: if matches!(value, Param::Null) { SetValue::Null } else { SetValue::Value(value.clone()) } };
        let assigned = assign(&mut req, ent, &spec)?;
        req.ir.set.push(assigned);
    }
    req.ir.n_params = req.params.len();
    let (id, _) = write(ex, &mut req).await?;
    let pk = &ent.primary_key[0];
    let key = if ent.identity.as_deref() == Some(pk.as_str()) {
        Param::I64(i64::try_from(id).map_err(|_| Error::internal("generated id is outside i64 range"))?)
    } else {
        match a.values.iter().find(|(c, _)| c == pk) {
            Some((_, v)) if !matches!(v, Param::Null) => v.clone(),
            _ => return Err(config(format!("the audit record {} has no {pk} after its insert", ent.table))),
        }
    };
    Ok(crate::tx::AuditKey { table: ent.table.clone(), key })
}

/// Restores the soft-deleted row that the set values name by its primary key or
/// one unique key, and returns the restored row. The other set values are new
/// values of the restored row. It clears the soft delete column with an update
/// that, on an audited table, writes the audit of the transaction like any other update. A
/// row that is not deleted is returned unchanged and nothing is written; a
/// missing row returns NO_ROWS. Reads never return a soft-deleted row: restore
/// names it explicitly.
pub async fn restore<M: Model>(m: &M) -> Result<M> {
    let c = m.core();
    let ex = terminal(c)?;
    let ent = c.ent.entity_schema()?;
    // key는 모든 column에 값이 정해진 primary key, 아니면 이름 순서로 처음 그런 unique key다.
    let value = |column: &str| {
        c.sets.iter().rev().filter(|s| s.column == column).find_map(|s| match &s.value {
            SetValue::Value(v) => Some(v.clone()),
            _ => None,
        })
    };
    let covered = |columns: &[String]| columns.iter().all(|column| value(column).is_some());
    let mut uniques: Vec<&dbspec::Key> = ent.uniques.iter().collect();
    uniques.sort_by(|a, b| a.name.cmp(&b.name));
    let key: &[String] = if covered(&ent.primary_key) {
        &ent.primary_key
    } else {
        match uniques.into_iter().find(|u| covered(&u.columns)) {
            Some(unique) => &unique.columns,
            None => return Err(config(format!("restore requires the set values of the primary key or a unique key of {}", ent.name))),
        }
    };
    // key 조건은 read와 같은 방법으로 만들므로 restore update와 그 뒤의 read가 같은 행을 같은 값 변환으로 찾는다.
    let mut q = Core::new(c.ent);
    q.conn = c.conn.clone();
    for (i, column) in key.iter().enumerate() {
        q.add_eq(if i == 0 { "" } else { "and" }, column, value(column).expect("covered key column"));
    }
    let mut req = build(&q, "restore");
    // key 밖의 set 값은 되돌리는 행에 함께 쓰는 새 값이다.
    for s in &c.sets {
        if key.contains(&s.column) {
            continue;
        }
        let a = assign(&mut req, &ent, s)?;
        req.ir.set.push(a);
    }
    req.ir.n_params = req.params.len();
    write(&ex, &mut req).await?;
    get_core(&q).await
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
            None => st.extra.get(name).cloned().ok_or_else(|| missing_output_column(c, name))?,
        };
        let value = v.to_json()?;
        let value = if styled_column(c, name)? {
            if matches!(v, Val::Null) {
                serde_json::json!({"kind": "sql-null"})
            } else {
                serde_json::json!({"kind": "value", "value": value})
            }
        } else {
            value
        };
        out.insert(name.clone(), value);
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

/// The JSON text of the row: the members of `to_array` in row order, with an
/// ordered-json value written as its text, so its member order and number
/// text stay as stored.
pub fn to_json(m: &dyn AnyModel) -> Result<String> {
    let members = json_members(m)?;
    let parts: Vec<String> = members.iter().map(|(name, text)| format!("{}:{text}", serde_json::Value::String(name.clone()))).collect();
    Ok(format!("{{{}}}", parts.join(",")))
}

/// The JSON output as a serde_json raw value, which a serde_json serializer
/// writes unchanged; serde serialization of models and collections uses it.
pub fn raw_json(text: Result<String>) -> Result<Box<serde_json::value::RawValue>> {
    serde_json::value::RawValue::from_string(text?)
        .map_err(|e| Error::Engine { code: crate::codes::CODEC_ENCODE.into(), msg: format!("json: model output: {e}") })
}

/// The members of the JSON output of a row: name and JSON text.
fn json_members(m: &dyn AnyModel) -> Result<Vec<(String, String)>> {
    let c = m.core_dyn();
    let mut out: Vec<(String, String)> = Vec::new();
    let add = |out: &mut Vec<(String, String)>, name: &str, text: String| {
        if !out.iter().any(|(n, _)| n == name) {
            out.push((name.to_owned(), text));
        }
    };
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
            None => st.extra.get(name).cloned().ok_or_else(|| missing_output_column(c, name))?,
        };
        let document = match &v {
            Val::Ordered(o) => o.compact(),
            other => other.to_json()?.to_string(),
        };
        let text = if styled_column(c, name)? {
            if matches!(v, Val::Null) {
                r#"{"kind":"sql-null"}"#.to_owned()
            } else {
                format!(r#"{{"kind":"value","value":{document}}}"#)
            }
        } else {
            document
        };
        add(&mut out, name, text);
    }
    for (name, v) in &c.news {
        add(&mut out, name, v.to_string());
    }
    for (name, rel) in &st.related {
        let text = match &rel.value {
            RelatedValue::One(None) => "null".to_owned(),
            RelatedValue::One(Some(child)) => to_json(child.as_ref())?,
            RelatedValue::Many(coll) => coll.to_json_dyn()?,
        };
        add(&mut out, name, text);
    }
    for rel in st.related.values() {
        if let (true, RelatedValue::One(Some(child))) = (rel.flat, &rel.value) {
            for (name, text) in json_members(child.as_ref())? {
                add(&mut out, &name, text);
            }
        }
    }
    Ok(out)
}

fn styled_column(c: &Core, name: &str) -> Result<bool> {
    Ok(c.ent.entity_schema()?.field(name).is_some_and(|column| column.styled_value()))
}

fn missing_output_column(c: &Core, name: &str) -> Error {
    if c.row.is_none() {
        Error::Engine { code: codes::COLUMN_UNSELECTED.into(), msg: format!("{}.{} has no decoded value", c.ent.name, name) }
    } else {
        Error::internal(format!("model output column {name} is missing"))
    }
}

#[cfg(test)]
mod column_decode_tests {
    use super::column_decode_error;
    use crate::{codes, Error};

    #[test]
    fn decoded_cell_failure_names_the_column() {
        let _case = orm_testcase::case!(orm_testcase::COMPUTE);
        let error = Error::Engine { code: codes::CODEC_DECODE.into(), msg: "non-null JSON column received NULL".into() };
        let error = column_decode_error("author", "jsons_tags", error);
        assert_eq!(error.code(), codes::CODEC_DECODE);
        assert_eq!(error.to_string(), "CODEC_DECODE: author.jsons_tags: non-null JSON column received NULL");
    }
}
#[cfg(test)]
mod related_tests {
    use super::{collect_boxed, new_boxed, Core, Entity, Model, Related, RelatedValue, RowState, Schema, Val};
    use crate::{codes, Result};
    use std::collections::HashMap;
    use std::sync::Arc;

    static SCHEMA: Schema = Schema::new("", "");
    static LEFT: Entity = Entity { name: "left", schema: &SCHEMA, new: new_boxed::<Left>, collect: collect_boxed::<Left> };
    static RIGHT: Entity = Entity { name: "right", schema: &SCHEMA, new: new_boxed::<Right>, collect: collect_boxed::<Right> };

    macro_rules! test_model {
        ($name:ident, $entity:ident) => {
            #[derive(Clone)]
            struct $name(Core);
            impl Model for $name {
                fn entity() -> &'static Entity {
                    &$entity
                }
                fn core(&self) -> &Core {
                    &self.0
                }
                fn core_mut(&mut self) -> &mut Core {
                    &mut self.0
                }
                fn from_core(core: Core) -> Self {
                    $name(core)
                }
                fn into_core(self) -> Core {
                    self.0
                }
                fn assign(&mut self, _: &str, _: Val) -> Result<bool> {
                    Ok(false)
                }
                fn value(&self, _: &str) -> Option<Val> {
                    None
                }
            }
        };
    }
    test_model!(Left, LEFT);
    test_model!(Right, RIGHT);

    /// one, 빈 one, many relation result를 가진 Left row.
    fn parent() -> Core {
        let mut row = RowState::default();
        let mut put = |name: &str, value: RelatedValue| {
            row.related.insert(name.to_owned(), Related { value, cascade: false, flat: false });
        };
        put("one", RelatedValue::One(Some(Arc::new(Right(Core::new(&RIGHT))))));
        put("empty", RelatedValue::One(None));
        put("many", RelatedValue::Many(collect_boxed::<Right>(Vec::new(), HashMap::new())));
        let mut core = Core::new(&LEFT);
        core.row = Some(row);
        core
    }

    /// 저장된 relation 값을 다른 model type이나 다른 relation 종류로 읽으면 INTERNAL이다.
    #[test]
    fn relation_results_report_a_mismatched_value() {
        let _case = orm_testcase::case!(orm_testcase::COMPUTE);
        let core = parent();
        assert!(core.related_one::<Right>("one").unwrap().is_some());
        assert!(core.related_one::<Right>("empty").unwrap().is_none());
        assert!(core.related_one::<Right>("absent").unwrap().is_none());
        assert!(core.related_many::<Right>("many").unwrap().is_some());
        assert!(core.related_many::<Right>("absent").unwrap().is_none());
        assert!(Core::new(&LEFT).related_one::<Right>("one").unwrap().is_none());
        for (error, names) in [
            (core.related_one::<Left>("one").map(|_| ()).unwrap_err(), ["one", "Left"]),
            (core.related_one::<Right>("many").map(|_| ()).unwrap_err(), ["many", "Right"]),
            (core.related_many::<Left>("many").map(|_| ()).unwrap_err(), ["many", "Left"]),
            (core.related_many::<Right>("one").map(|_| ()).unwrap_err(), ["one", "Right"]),
            (core.related_many::<Right>("empty").map(|_| ()).unwrap_err(), ["empty", "Right"]),
        ] {
            assert_eq!(error.code(), codes::INTERNAL, "{error}");
            for name in names {
                assert!(error.to_string().contains(name), "{error} does not name {name}");
            }
        }
    }
}
