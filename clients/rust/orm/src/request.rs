//! A statement under construction and the rendering of a model into it.

use std::collections::{HashMap, HashSet};

use crate::core::{config, Added, CondKind, CondNode, Core, PredSpec, PredValue, RawSpec, RelSpec};
use crate::ir;
use crate::schema::Schema;
use crate::value::Param;
use crate::{codes, Error, Result};

/// The value-free IR of one statement plus its parameter values.
#[derive(Clone)]
pub struct Req {
    pub ir: ir::Request,
    pub params: Vec<Param>,
    pub err: Option<(String, String)>,
    /// The schema the statement is planned with.
    pub schema: &'static Schema,
    /// Relations whose child has its own connection, by parent model identity.
    pub(crate) external: HashMap<u64, Vec<RelSpec>>,
}

impl Req {
    pub fn new(schema: &'static Schema, kind: &str, entity: &str) -> Req {
        Req {
            ir: ir::Request {
                ir_version: 1,
                schema_hash: schema.hash().to_owned(),
                kind: kind.to_owned(),
                query: ir::Query { entity: entity.to_owned(), ..Default::default() },
                ..Default::default()
            },
            params: Vec::new(),
            err: None,
            schema,
            external: HashMap::new(),
        }
    }

    pub fn p(&mut self, v: Param) -> usize {
        self.params.push(v);
        self.params.len() - 1
    }

    pub(crate) fn fail(&mut self, e: Error) {
        if self.err.is_none() {
            self.err = Some((e.code().to_owned(), e.to_string()));
        }
    }

    pub fn error(&self) -> Option<Error> {
        self.err.as_ref().map(|(code, msg)| Error::Engine { code: code.clone(), msg: msg.clone() })
    }

    /// The plan-cache key: FNV-1a 64 over the IR bytes, streamed without allocating them.
    pub fn shape_key(&mut self) -> u64 {
        self.ir.n_params = self.params.len();
        let mut h = Fnv(FNV_OFFSET);
        serde_json::to_writer(&mut h, &self.ir).expect("ir serializes");
        h.0
    }
}

const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

struct Fnv(u64);

impl std::io::Write for Fnv {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        for &b in buf {
            self.0 ^= b as u64;
            self.0 = self.0.wrapping_mul(FNV_PRIME);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The result name of a relation or join: the alias, otherwise
/// `<table>_model` or `<table>_models`.
pub(crate) fn result_name(c: &Core, many: bool) -> String {
    if !c.alias.is_empty() {
        return snake(&c.alias);
    }
    format!("{}_{}", c.ent.name, if many { "models" } else { "model" })
}

pub(crate) fn snake(s: &str) -> String {
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// One statement being built: its models and their join paths.
struct Frame<'a> {
    root: u64,
    cores: HashMap<u64, &'a Core>,
    paths: HashMap<u64, String>,
    parent: HashMap<u64, u64>,
    placed: HashSet<u64>,
    /// The model that owns a subquery; the subquery refers to it as "^".
    outer: Option<u64>,
}

impl<'a> Frame<'a> {
    fn new(root: &'a Core, outer: Option<u64>) -> Frame<'a> {
        let mut f = Frame { root: root.id, cores: HashMap::new(), paths: HashMap::new(), parent: HashMap::new(), placed: HashSet::new(), outer };
        f.paths.insert(root.id, String::new());
        f.register(root, "");
        f
    }

    fn register(&mut self, c: &'a Core, prefix: &str) {
        for j in &c.joins {
            let path = format!("{prefix}{}", result_name(&j.child, false));
            self.cores.insert(j.child.id, &j.child);
            self.paths.insert(j.child.id, path.clone());
            self.parent.insert(j.child.id, c.id);
            self.register(&j.child, &format!("{path}/"));
        }
    }

    fn path_of(&self, id: u64) -> Result<String> {
        if let Some(p) = self.paths.get(&id) {
            return Ok(p.clone());
        }
        if self.outer == Some(id) {
            return Ok("^".into());
        }
        Err(config("the compared model is not part of the statement"))
    }
}

fn last_segment(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_owned()
}

/// Renders the model as a request of kind.
pub(crate) fn build(c: &Core, kind: &str) -> Req {
    let mut r = Req::new(c.ent.schema, kind, c.ent.name);
    if let Some(e) = c.err() {
        r.fail(e);
        return r;
    }
    let mut f = Frame::new(c, None);
    let mut joins = HashSet::new();
    if let Some(q) = query(&mut r, c, &mut f, &mut joins) {
        r.ir.query = q;
    }
    r.ir.n_params = r.params.len();
    r
}

fn query(r: &mut Req, c: &Core, f: &mut Frame<'_>, joins: &mut HashSet<String>) -> Option<ir::Query> {
    if let Some(e) = c.err() {
        r.fail(e);
        return None;
    }
    if !c.where_.pending.is_empty() {
        r.fail(config(format!("connector {} without a following condition", c.where_.pending)));
        return None;
    }
    let mut q = ir::Query {
        entity: c.ent.name.to_owned(),
        force_index: c.index.clone(),
        lock: c.lock.to_owned(),
        limit: c.limit.map(|(offset, count)| ir::Limit { offset, count }),
        ..Default::default()
    };
    q.columns = columns(r, c)?;
    for j in &c.joins {
        let path = f.paths[&j.child.id].clone();
        if !joins.insert(path.clone()) {
            r.fail(config(format!("join result name {} is used twice", last_segment(&path))));
            return None;
        }
        let mut child = query(r, &j.child, f, joins)?;
        if let Some(on) = &j.child.on {
            child.on = Some(group(r, on, &j.child, f)?);
        }
        q.joins.push(ir::Join { rel: last_segment(&path), kind: j.kind.to_owned(), query: Box::new(child), left: j.left.clone(), right: j.right.clone() });
    }
    if !c.where_.items.is_empty() {
        q.where_ = Some(group(r, &c.where_.items, c, f)?);
    }
    for rel in &c.relations {
        if rel.child.conn.is_some() {
            if rel.child.limit.is_some() {
                r.fail(Error::Engine { code: codes::LIMIT_IN_RELATION.into(), msg: format!("{} relation uses limit; use group_limit", rel.child.ent.name) });
                return None;
            }
            r.external.entry(c.id).or_default().push(rel.clone());
            continue;
        }
        let child = relation(r, rel)?;
        q.relations.push(child);
    }
    for o in &c.order {
        if o.random {
            q.order.push(ir::Order { random: true, ..Default::default() });
        } else if let Some(raw) = &o.raw {
            q.order.push(ir::Order { expr: raw.clone(), ..Default::default() });
        } else {
            let func = o.func.as_ref().map(|func| func_ir(r, func));
            q.order.push(ir::Order { column: o.column.clone(), desc: o.desc, r#fn: func, ..Default::default() });
        }
    }
    q.group_by = c.group_by.clone();
    for (i, g) in c.group_raw.iter().enumerate() {
        q.group_by_expr.push(ir::GroupExpr { expr: g.clone(), as_: format!("group_{}", i + 1) });
    }
    Some(q)
}

fn relation(r: &mut Req, rel: &RelSpec) -> Option<ir::Relation> {
    let ch = &rel.child;
    let mut f = Frame::new(ch, None);
    let mut joins = HashSet::new();
    let mut q = query(r, ch, &mut f, &mut joins)?;
    if ch.limit.is_some() {
        r.fail(Error::Engine { code: codes::LIMIT_IN_RELATION.into(), msg: format!("{} relation uses limit; use group_limit", ch.ent.name) });
        return None;
    }
    q.flatten = ch.parent_node;
    q.limit_per_parent = ch.group_limit;
    q.no_cascade_delete = ch.delete_lock;
    q.key_by = ch.key_name.clone();
    if let Some((column, value)) = &ch.possible {
        let p = r.p(value.clone());
        q.if_parent = Some(ir::IfParent { column: column.clone(), p });
    }
    Some(ir::Relation {
        rel: result_name(ch, rel.many),
        query: Box::new(q),
        kind: if rel.many { "many" } else { "one" }.into(),
        left: ch.match_left.clone(),
        right: ch.match_right.clone(),
    })
}

fn func_ir(r: &mut Req, f: &crate::args::Func) -> ir::Func {
    let ps = f.args.iter().map(|a| r.p(a.clone())).collect();
    ir::Func { name: f.name.to_owned(), ps }
}

fn raw_expr(r: &mut Req, raw: &RawSpec) -> ir::Expr {
    let n = raw.sql.matches('?').count();
    if n != raw.binds.len() {
        r.fail(Error::Engine { code: codes::IR_INVALID.into(), msg: format!("raw SQL has {n} placeholders and {} binds", raw.binds.len()) });
    }
    let ps = raw.binds.iter().map(|b| r.p(b.clone())).collect();
    ir::Expr { sql: raw.sql.clone(), ps }
}

fn columns(r: &mut Req, c: &Core) -> Option<Option<ir::Columns>> {
    let spec = &c.columns;
    let mut out = ir::Columns { mode: spec.mode.to_owned(), add: spec.add.clone(), remove: spec.remove.clone(), ..Default::default() };
    for (name, added) in &spec.added {
        match added {
            Added::Format(column, format) => {
                if format.matches("%s").count() != 1 {
                    r.fail(config(format!("column format for {name} must contain one %s")));
                    return None;
                }
                out.expr.insert(name.clone(), ir::Expr { sql: format.replacen("%s", &format!("{{{column}}}"), 1), ps: Vec::new() });
            }
            Added::Func(column, f) => {
                let func = func_ir(r, f);
                out.r#fn.insert(name.clone(), ir::ColFunc { column: column.clone(), r#fn: func });
            }
            Added::Raw(raw) => {
                let e = raw_expr(r, raw);
                out.expr.insert(name.clone(), e);
            }
            Added::Sub(func) => {
                let core = func(c);
                let sub = subquery(r, &core, c.id, true)?;
                out.sub.insert(name.clone(), sub);
            }
        }
    }
    if out.mode.is_empty() && out.add.is_empty() && out.remove.is_empty() && out.expr.is_empty() && out.r#fn.is_empty() && out.sub.is_empty() {
        return Some(None);
    }
    Some(Some(out))
}

fn group(r: &mut Req, items: &[CondNode], owner: &Core, f: &mut Frame<'_>) -> Option<ir::Group> {
    let mut out = ir::Group::default();
    for node in items {
        let item = match &node.kind {
            CondKind::Pred(p) => {
                let mut pred = pred(r, p, owner, f)?;
                pred.conn = node.conn.to_owned();
                ir::Item::Pred { pred: Box::new(pred) }
            }
            CondKind::Raw(raw) => {
                let e = raw_expr(r, raw);
                ir::Item::Pred { pred: Box::new(ir::Pred { conn: node.conn.to_owned(), expr: e.sql, ps: e.ps, ..Default::default() }) }
            }
            CondKind::Group(items) => {
                let mut g = group(r, items, owner, f)?;
                g.conn = node.conn.to_owned();
                ir::Item::Group { group: g }
            }
            CondKind::Joined(id) => {
                let Some(path) = f.paths.get(id).filter(|_| *id != f.root).cloned() else {
                    r.fail(config("the placed model is not joined in the statement"));
                    return None;
                };
                if f.parent.get(id) != Some(&owner.subject_id()) {
                    r.fail(config("joined conditions must be placed in the model they are joined to"));
                    return None;
                }
                if !f.placed.insert(*id) {
                    r.fail(config("joined conditions are placed twice"));
                    return None;
                }
                if f.cores.get(id).map(|c| c.where_.items.is_empty()).unwrap_or(true) {
                    r.fail(config("the placed model has no condition"));
                    return None;
                }
                ir::Item::Joined { joined: ir::JoinedRef { conn: node.conn.to_owned(), join: last_segment(&path) } }
            }
        };
        out.items.push(item);
    }
    Some(out)
}

fn pred(r: &mut Req, p: &PredSpec, owner: &Core, f: &mut Frame<'_>) -> Option<ir::Pred> {
    let mut out = ir::Pred { column: p.column.clone(), op: p.op.to_owned(), ..Default::default() };
    match &p.value {
        PredValue::None => {}
        PredValue::One(v) => out.p = Some(r.p(v.clone())),
        PredValue::List(list) => {
            for v in pad_in(list) {
                out.ps.push(r.p(v));
            }
        }
        PredValue::Pair(a, b) => {
            out.ps.push(r.p(a.clone()));
            out.ps.push(r.p(b.clone()));
        }
        PredValue::Tuples(cols, rows) => {
            out.cols = cols.iter().map(|c| c.to_string()).collect();
            for row in rows {
                if row.len() != cols.len() {
                    r.fail(config("every tuple needs one value per column"));
                    return None;
                }
                for v in row {
                    out.ps.push(r.p(v.clone()));
                }
            }
        }
        PredValue::Match(cols, v) => {
            out.match_ = cols.iter().map(|c| c.to_string()).collect();
            out.p = Some(r.p(v.clone()));
        }
        PredValue::Ref(id, column) => match f.path_of(*id) {
            Ok(path) => out.r#ref = Some(ir::ColRef { path, column: column.to_string() }),
            Err(e) => {
                r.fail(e);
                return None;
            }
        },
        PredValue::Sub(core) => out.sub = Some(subquery(r, core, owner.subject_id(), false)?),
        PredValue::ColumnFn(func, compared) => {
            out.r#fn = Some(func_ir(r, func));
            out.p = Some(r.p(compared.clone()));
        }
        PredValue::ValueFn(func) => out.value = Some(func_ir(r, func)),
    }
    Some(out)
}

/// Renders an unexecuted model as a subquery; `scalar` selects a column
/// subquery, which may aggregate.
fn subquery(r: &mut Req, c: &Core, outer: u64, scalar: bool) -> Option<ir::Sub> {
    if c.conn.is_some() {
        r.fail(config("a subquery model cannot have its own connection"));
        return None;
    }
    if !c.relations.is_empty() {
        r.fail(config("a subquery model cannot load relations"));
        return None;
    }
    let mut f = Frame::new(c, Some(outer));
    let mut joins = HashSet::new();
    let mut q = query(r, c, &mut f, &mut joins)?;
    let (column, agg) = if scalar && !c.agg.is_empty() {
        (c.agg.clone(), c.agg_fn.to_owned())
    } else if c.columns.add.len() == 1 {
        (c.columns.add[0].clone(), String::new())
    } else {
        r.fail(config("a subquery model must add exactly one column with add_column_<col>()"));
        return None;
    };
    q.columns = None;
    Some(ir::Sub { query: Box::new(q), column, agg })
}

/// Rounds a list up to a power of two by repeating its last value, so the
/// number of distinct statements stays logarithmic in the list length.
fn pad_in(vs: &[Param]) -> Vec<Param> {
    let mut n = 1;
    while n < vs.len() {
        n <<= 1;
    }
    let mut out = vs.to_vec();
    let last = vs[vs.len() - 1].clone();
    out.resize(n, last);
    out
}
