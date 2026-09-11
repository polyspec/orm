//! Untyped cores of the generated builders. Q owns the request; W edits one
//! group while borrowing the params list and the group as *disjoint* fields.

use crate::ir::*;
use crate::value::Param;

pub struct Req {
    pub ir: Request,
    pub params: Vec<Param>,
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
        }
    }

    pub fn p(&mut self, v: impl Into<Param>) -> usize {
        self.params.push(v.into());
        self.params.len() - 1
    }

    /// Merge a child request: append its params and shift its indices.
    pub fn attach(&mut self, child: Req) -> Query {
        let off = self.params.len();
        self.params.extend(child.params);
        let mut q = child.ir.query;
        q.shift(off);
        q
    }

    /// IR bytes with n_params set (the plan-cache key and the engine input).
    pub fn shape(&mut self) -> Vec<u8> {
        self.ir.n_params = self.params.len();
        serde_json::to_vec(&self.ir).expect("ir serializes")
    }
}

/// Query builder core. Generated types wrap this and move `self` through the chain.
pub struct Q {
    pub req: Req,
    pending_or: bool,
}

impl Q {
    pub fn new(schema_hash: &str, entity: &str) -> Q {
        Q { req: Req::new(schema_hash, entity), pending_or: false }
    }

    pub fn node(&mut self) -> &mut Query {
        &mut self.req.ir.query
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

    pub fn or(&mut self) {
        self.pending_or = true;
    }

    pub fn join(&mut self, rel: &str, kind: &str, child: Q) {
        let q = self.req.attach(child.req);
        self.req.ir.query.joins.push(Join { rel: rel.into(), kind: kind.into(), query: Box::new(q) });
    }

    pub fn relation(&mut self, rel: &str, child: Q) {
        let q = self.req.attach(child.req);
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
        let ps = vs.into_iter().map(|v| self.p(v)).collect();
        self.g.items.push(Item::Pred { pred: Pred { conn, column: col.into(), op: op.into(), ps, ..Default::default() } });
    }

    pub fn pred_null(&mut self, col: &str, op: &str) {
        let conn = self.conn();
        self.g.items.push(Item::Pred { pred: Pred { conn, column: col.into(), op: op.into(), ..Default::default() } });
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
