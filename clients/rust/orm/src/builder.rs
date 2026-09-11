//! Untyped cores of the generated builders. Q owns the request; W edits one
//! group while borrowing the params list and the group as *disjoint* fields.

use crate::ir::*;
use crate::value::Param;

pub struct Req {
    pub ir: Request,
    pub params: Vec<Param>,
    /// First deferred builder error (codec encode); surfaces from the terminal.
    pub err: Option<DeferredError>,
}

#[derive(Debug, Clone)]
pub struct DeferredError {
    pub code: String,
    pub message: String,
}

impl DeferredError {
    pub fn from_error(e: crate::Error) -> Self {
        Self { code: e.code().into(), message: e.to_string() }
    }

    pub fn error(&self) -> crate::Error {
        crate::Error::Engine { code: self.code.clone(), msg: self.message.clone() }
    }
}

impl Req {
    pub fn new(schema_hash: &str, entity: &str) -> Req {
        Req {
            ir: Request {
                ir_version: 1,
                schema_hash: schema_hash.to_owned(),
                kind: "all".into(),
                query: Query { entity: entity.to_owned(), ..Default::default() },
                ..Default::default()
            },
            params: Vec::new(),
            err: None,
        }
    }

    pub fn p(&mut self, v: impl Into<Param>) -> usize {
        self.params.push(v.into());
        self.params.len() - 1
    }

    /// Merge a child request: append its params and shift its indices.
    pub fn attach(&mut self, child: &Req) -> Query {
        let off = self.params.len();
        if self.err.is_none() { self.err = child.err.clone(); }
        self.params.extend_from_slice(&child.params);
        let mut q = child.ir.query.clone();
        q.shift(off);
        q
    }

    /// IR bytes with n_params set (the engine input on a plan-cache miss).
    pub fn shape(&mut self) -> Vec<u8> {
        self.ir.n_params = self.params.len();
        serde_json::to_vec(&self.ir).expect("ir serializes")
    }

    /// The plan-cache key: FNV-1a 64 over the same bytes `shape()` would produce, streamed
    /// through the hasher without allocating them.
    pub fn shape_key(&mut self) -> u64 {
        self.ir.n_params = self.params.len();
        let mut h = Fnv(FNV_OFFSET);
        serde_json::to_writer(&mut h, &self.ir).expect("ir serializes");
        h.0
    }
}

const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

/// FNV-1a 64 as an `io::Write` sink: hashes every byte serde writes, allocation-free.
struct Fnv(u64);

impl std::io::Write for Fnv {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut h = self.0;
        for &b in buf {
            h ^= b as u64;
            h = h.wrapping_mul(FNV_PRIME);
        }
        self.0 = h;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Rounds an IN list up to a power of two by repeating its last value. A repeated
/// value cannot change what IN or NOT IN match, and it keeps the number of distinct
/// statements logarithmic in the list length instead of linear: without it every
/// length mints its own plan and its own server-side prepared statement (MySQL's
/// max_prepared_stmt_count is 16382 by default). Relation IN lists are bucketed the
/// same way when the executor expands them.
fn pad_in(op: &str, mut vs: Vec<Param>) -> Vec<Param> {
    if (op != "in" && op != "not_in") || vs.len() < 2 {
        return vs;
    }
    let mut n = 1;
    while n < vs.len() {
        n <<= 1;
    }
    let last = vs[vs.len() - 1].clone();
    vs.resize(n, last);
    vs
}

/// A column of another entity in the same statement, for column-to-column
/// predicates: path "" is the parent (inside on()/where() of a join child) or
/// the root; `.at("service")` / `.at("campaign/service")` walks joins.
#[derive(Debug, Clone)]
pub struct ColRef {
    pub path: String,
    pub column: &'static str,
}

impl ColRef {
    pub const fn new(column: &'static str) -> ColRef {
        ColRef { path: String::new(), column }
    }

    pub fn at(mut self, path: &str) -> ColRef {
        self.path = path.to_owned();
        self
    }
}

/// Query builder core. Generated types wrap this and move `self` through the chain.
pub struct Q {
    pub req: Req,
    pub link_left: String,
    pub link_right: String,
    pending_or: bool,
}

impl Q {
    pub fn new(schema_hash: &str, entity: &str) -> Q {
        Q { req: Req::new(schema_hash, entity), link_left: String::new(), link_right: String::new(), pending_or: false }
    }

    pub fn entity(&self) -> &str { &self.req.ir.query.entity }

    pub fn set_link(&mut self, left: &str, right: &str) {
        self.link_left = left.into();
        self.link_right = right.into();
    }

    pub fn node(&mut self) -> &mut Query {
        &mut self.req.ir.query
    }

    /// Keeps the first builder error for the terminal to return.
    pub fn defer_err(&mut self, e: crate::Error) {
        if self.req.err.is_none() {
            self.req.err = Some(DeferredError::from_error(e));
        }
    }

    /// A W over the root WHERE group, carrying the pending connector.
    pub fn w(&mut self) -> W<'_> {
        let pending = std::mem::take(&mut self.pending_or);
        let req = &mut self.req;
        let g = req.ir.query.where_.get_or_insert_with(Group::default);
        W { params: &mut req.params, g, pending_or: pending }
    }

    /// A W over the ON group (join children).
    pub fn on_w(&mut self) -> W<'_> {
        let req = &mut self.req;
        let g = req.ir.query.on.get_or_insert_with(Group::default);
        W { params: &mut req.params, g, pending_or: false }
    }

    /// A W over the root HAVING group (group predicates after group_by).
    pub fn having_w(&mut self) -> W<'_> {
        let req = &mut self.req;
        let g = req.ir.query.having.get_or_insert_with(Group::default);
        W { params: &mut req.params, g, pending_or: false }
    }

    pub fn or(&mut self) {
        self.pending_or = true;
    }

    /// Stores a hand-written SELECT to run as the root (kind raw): `{table}` is the
    /// entity table, each `?` binds the next of `binds`.
    pub fn raw(&mut self, sql: &str, binds: Vec<Param>) {
        let ps = binds.into_iter().map(|b| self.req.p(b)).collect();
        self.req.ir.raw = Some(Raw { sql: sql.into(), ps });
    }

    pub fn join(&mut self, rel: &str, kind: &str, child: &Q) {
        let q = self.req.attach(&child.req);
        self.req.ir.query.joins.push(Join { rel: rel.into(), kind: kind.into(), query: Box::new(q) });
    }

    pub fn relation(&mut self, rel: &str, child: &Q) {
        let q = self.req.attach(&child.req);
        self.req.ir.query.relations.push(Relation { rel: rel.into(), query: Box::new(q) });
    }

    pub fn columns(&mut self) -> &mut Columns {
        self.req.ir.query.columns.get_or_insert_with(Columns::default)
    }

    pub fn order(&mut self, col: &str, desc: bool) {
        self.req.ir.query.order.push(Order { column: col.into(), expr: String::new(), desc });
    }

    pub fn order_expr(&mut self, frag: &str, desc: bool) {
        self.req.ir.query.order.push(Order { column: String::new(), expr: frag.into(), desc });
    }

    pub fn group_by_expr(&mut self, expr: &str, as_: &str) {
        self.req.ir.query.group_by_expr.push(GroupExpr { expr: expr.into(), as_: as_.into() });
    }

    pub fn set(&mut self, col: &str, v: impl Into<Param>) {
        let v = v.into();
        if matches!(v, Param::Null) {
            self.req.ir.set.push(Assign { column: col.into(), null: true, ..Default::default() });
        } else {
            let p = self.req.p(v);
            self.req.ir.set.push(Assign { column: col.into(), p: Some(p), ..Default::default() });
        }
    }

    pub fn set_expr(&mut self, col: &str, frag: &str, binds: Vec<Param>) {
        let ps = binds.into_iter().map(|b| self.req.p(b)).collect();
        self.req.ir.set.push(Assign { column: col.into(), expr: frag.into(), ps, ..Default::default() });
    }

    pub fn plus(&mut self, col: &str, v: impl Into<Param>) {
        let p = self.req.p(v);
        self.req.ir.set.push(Assign { column: col.into(), plus_p: Some(p), ..Default::default() });
    }

    pub fn minus(&mut self, col: &str, v: impl Into<Param>) {
        let p = self.req.p(v);
        self.req.ir.set.push(Assign { column: col.into(), minus_p: Some(p), ..Default::default() });
    }

    pub fn if_parent(&mut self, col: &str, v: impl Into<Param>) {
        let p = self.req.p(v);
        self.req.ir.query.if_parent = Some(IfParent { column: col.into(), p });
    }

    // ---- insert: ON DUPLICATE KEY UPDATE assignments ----
    pub fn on_duplicate_set(&mut self, col: &str, v: impl Into<Param>) {
        let v = v.into();
        if matches!(v, Param::Null) {
            self.req.ir.on_duplicate.push(Assign { column: col.into(), null: true, ..Default::default() });
        } else {
            let p = self.req.p(v);
            self.req.ir.on_duplicate.push(Assign { column: col.into(), p: Some(p), ..Default::default() });
        }
    }

    pub fn on_duplicate_set_expr(&mut self, col: &str, frag: &str, binds: Vec<Param>) {
        let ps = binds.into_iter().map(|b| self.req.p(b)).collect();
        self.req.ir.on_duplicate.push(Assign { column: col.into(), expr: frag.into(), ps, ..Default::default() });
    }

    pub fn on_duplicate_plus(&mut self, col: &str, v: impl Into<Param>) {
        let p = self.req.p(v);
        self.req.ir.on_duplicate.push(Assign { column: col.into(), plus_p: Some(p), ..Default::default() });
    }

    pub fn on_duplicate_minus(&mut self, col: &str, v: impl Into<Param>) {
        let p = self.req.p(v);
        self.req.ir.on_duplicate.push(Assign { column: col.into(), minus_p: Some(p), ..Default::default() });
    }

    /// Copies every current set[] assignment except `skip` (the PK/auto columns)
    /// into on_duplicate, at call time: later set_* calls are not mirrored.
    pub fn on_duplicate_set_all(&mut self, skip: &[&str]) {
        let copies: Vec<Assign> = self.req.ir.set.iter().filter(|a| !skip.contains(&a.column.as_str())).cloned().collect();
        self.req.ir.on_duplicate.extend(copies);
    }

    /// Removes the value assignment of `col` from set[] and returns its value
    /// (save: the PK decides between UPDATE and INSERT). An expr/plus/minus
    /// assignment of the column is not a value and stays.
    pub fn take_set(&mut self, col: &str) -> Option<Param> {
        let i = self.req.ir.set.iter().position(|a| a.column == col && (a.p.is_some() || a.null))?;
        let a = self.req.ir.set.remove(i);
        Some(match a.p {
            Some(p) => self.req.params[p].clone(),
            None => Param::Null,
        })
    }
}

/// Group builder: borrows the params list and the group it edits (disjoint fields of Req).
pub struct W<'a> {
    pub params: &'a mut Vec<Param>,
    pub g: &'a mut Group,
    pending_or: bool,
}

impl<'a> W<'a> {
    fn conn(&mut self) -> String {
        if std::mem::take(&mut self.pending_or) {
            "or".into()
        } else {
            String::new()
        }
    }

    fn p(&mut self, v: impl Into<Param>) -> usize {
        self.params.push(v.into());
        self.params.len() - 1
    }

    pub fn or(&mut self) {
        self.pending_or = true;
    }

    pub fn pred(&mut self, col: &str, op: &str, v: impl Into<Param>) {
        let conn = self.conn();
        let p = self.p(v);
        self.g.items.push(Item::Pred { pred: Pred { conn, column: col.into(), op: op.into(), p: Some(p), ..Default::default() } });
    }

    pub fn pred_list(&mut self, col: &str, op: &str, vs: Vec<Param>) {
        let conn = self.conn();
        let ps = pad_in(op, vs).into_iter().map(|v| self.p(v)).collect();
        self.g.items.push(Item::Pred { pred: Pred { conn, column: col.into(), op: op.into(), ps, ..Default::default() } });
    }

    pub fn pred_null(&mut self, col: &str, op: &str) {
        let conn = self.conn();
        self.g.items.push(Item::Pred { pred: Pred { conn, column: col.into(), op: op.into(), ..Default::default() } });
    }

    pub fn pred_col(&mut self, col: &str, op: &str, r: ColRef) {
        let conn = self.conn();
        self.g.items.push(Item::Pred { pred: Pred { conn, column: col.into(), op: op.into(), r#ref: Some(crate::ir::ColRef { path: r.path, column: r.column.into() }), ..Default::default() } });
    }

    pub fn match_(&mut self, cols: &[&str], boolean: bool, v: &str) {
        let conn = self.conn();
        let p = self.p(v);
        self.g.items.push(Item::Pred {
            pred: Pred {
                conn,
                op: if boolean { "match_boolean" } else { "match" }.into(),
                match_: cols.iter().map(|c| c.to_string()).collect(),
                p: Some(p),
                ..Default::default()
            },
        });
    }

    pub fn expr(&mut self, frag: &str, binds: Vec<Param>) {
        let conn = self.conn();
        let ps = binds.into_iter().map(|b| self.p(b)).collect();
        self.g.items.push(Item::Pred { pred: Pred { conn, expr: frag.into(), ps, ..Default::default() } });
    }

    /// Opens a parenthesised group and hands a W over it to `f`.
    pub fn and_with(&mut self, f: impl FnOnce(W<'_>)) {
        let conn = self.conn();
        self.g.items.push(Item::Group { group: Group { conn, items: Vec::new() } });
        let Some(Item::Group { group }) = self.g.items.last_mut() else { unreachable!() };
        f(W { params: &mut *self.params, g: group, pending_or: false });
    }

    /// Descends into a joined relation.
    pub fn nav_with(&mut self, rel: &str, f: impl FnOnce(W<'_>)) {
        let conn = self.conn();
        self.g.items.push(Item::Nav { nav: Nav { conn, rel: rel.into(), group: Group::default() } });
        let Some(Item::Nav { nav }) = self.g.items.last_mut() else { unreachable!() };
        f(W { params: &mut *self.params, g: &mut nav.group, pending_or: false });
    }
}
