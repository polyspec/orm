//! The canonical parameter walk of a request, in the order of packages/go/orm/canonical.go.
//!
//! The walk pads each IN list to its power-of-two bucket, gives every parameter reference a slot of its own
//! in walk order, and renumbers the IR from that walk alone, so the plan cache key of a request does not depend
//! on the order its parameters were built in. A parameter no reference names keeps its value after the slots.

use crate::ir;
use crate::value::Param;
use crate::{Error, Result};

/// Renumbers the parameters of a request in walk order (see the module comment).
pub(crate) fn canonicalize(request: &mut ir::Request, params: &mut Vec<Param>) -> Result<()> {
    let used = vec![false; params.len()];
    let mut c = Canonicalizer { params: std::mem::take(params), out: Vec::new(), used, err: None };
    request.query = c.query(&request.query, true);
    request.set = request.set.iter().map(|a| c.assign(a)).collect();
    request.on_duplicate = request.on_duplicate.iter().map(|a| c.assign(a)).collect();
    request.rows = request.rows.iter().map(|row| c.ints(row)).collect();
    request.optimistic = request.optimistic.as_ref().map(|o| ir::Optimist { column: o.column.clone(), p: c.index(o.p) });
    if let Some(err) = c.err {
        *params = c.params;
        return Err(err);
    }
    // A parameter no reference names keeps its value after the slots, so the request still holds the values it was sent with.
    for (i, u) in c.used.iter().enumerate() {
        if !*u {
            c.out.push(c.params[i].clone());
        }
    }
    request.n_params = c.out.len();
    *params = c.out;
    Ok(())
}

struct Canonicalizer {
    params: Vec<Param>,
    out: Vec<Param>,
    used: Vec<bool>,
    err: Option<Error>,
}

impl Canonicalizer {
    fn fail(&mut self, kind: crate::Kind, msg: impl Into<String>) {
        if self.err.is_none() {
            self.err = Some(Error::new(kind, msg));
        }
    }

    /// Adds one slot holding the value of parameter p and returns its index. A reference past the parameters is
    /// IR_INVALID, which the validator would also report.
    fn index(&mut self, p: usize) -> usize {
        if p >= self.params.len() {
            self.fail(crate::Kind::IrInvalid, format!("param index {p} out of range (n_params {})", self.params.len()));
            return p;
        }
        self.used[p] = true;
        self.out.push(self.params[p].clone());
        self.out.len() - 1
    }

    /// Adds a literal page value as a slot and returns its index.
    fn literal(&mut self, value: u32) -> usize {
        self.out.push(Param::I64(i64::from(value)));
        self.out.len() - 1
    }

    fn ints(&mut self, ps: &[usize]) -> Vec<usize> {
        ps.iter().map(|&p| self.index(p)).collect()
    }

    /// Pads an IN list to its bucket: the slots past the last value repeat it.
    fn list(&mut self, ps: &[usize]) -> Vec<usize> {
        let n = ps.len();
        if n == 0 {
            return Vec::new();
        }
        let bucket = n.next_power_of_two();
        (0..bucket).map(|j| self.index(ps[j.min(n - 1)])).collect()
    }

    fn func(&mut self, f: &ir::Func) -> ir::Func {
        ir::Func { name: f.name.clone(), ps: self.ints(&f.ps) }
    }

    fn sub(&mut self, s: &ir::Sub) -> ir::Sub {
        let mut v = s.clone();
        v.query = Box::new(self.query(&s.query, false));
        v
    }

    fn assign(&mut self, a: &ir::Assign) -> ir::Assign {
        let mut v = a.clone();
        v.p = a.p.map(|p| self.index(p));
        v.plus_p = a.plus_p.map(|p| self.index(p));
        v.minus_p = a.minus_p.map(|p| self.index(p));
        v
    }

    fn group(&mut self, g: &ir::Group) -> ir::Group {
        let mut v = g.clone();
        v.items = g
            .items
            .iter()
            .map(|item| match item {
                ir::Item::Pred { pred } => ir::Item::Pred { pred: Box::new(self.pred(pred)) },
                ir::Item::Group { group } => ir::Item::Group { group: self.group(group) },
                ir::Item::Joined { joined } => ir::Item::Joined { joined: joined.clone() },
            })
            .collect();
        v
    }

    fn pred(&mut self, p: &ir::Pred) -> ir::Pred {
        let mut v = p.clone();
        v.p = p.p.map(|x| self.index(x));
        v.ps = if (p.op == "in" || p.op == "not_in") && p.sub.is_none() { self.list(&p.ps) } else { self.ints(&p.ps) };
        // A column function takes no parameter (engine/validate.rs refuses one), so of the functions only a value
        // function holds slots.
        v.value = p.value.as_ref().map(|f| self.func(f));
        v.sub = p.sub.as_ref().map(|s| self.sub(s));
        v
    }

    /// Walks a query in the order of the Go walk: column functions and subqueries (by name), on, where, joins,
    /// relations, order, limit, and the parent condition. Only the root query may hold page parameters.
    fn query(&mut self, q: &ir::Query, root: bool) -> ir::Query {
        let mut out = q.clone();
        if let Some(cols) = &q.columns {
            let mut c = cols.clone();
            c.sub = cols.sub.iter().map(|(k, s)| (k.clone(), self.sub(s))).collect();
            out.columns = Some(c);
        }
        out.on = q.on.as_ref().map(|g| self.group(g));
        out.where_ = q.where_.as_ref().map(|g| self.group(g));
        out.joins = q
            .joins
            .iter()
            .map(|j| {
                let mut v = j.clone();
                v.query = Box::new(self.query(&j.query, false));
                v
            })
            .collect();
        out.relations = q
            .relations
            .iter()
            .map(|rel| {
                let mut v = rel.clone();
                v.query = Box::new(self.query(&rel.query, false));
                v
            })
            .collect();
        out.limit = q.limit.as_ref().map(|l| match *l {
            ir::Limit::Params { offset_p, count_p } => {
                let offset_p = self.index(offset_p);
                let count_p = self.index(count_p);
                ir::Limit::Params { offset_p, count_p }
            }
            ir::Limit::Literal { offset, count } => {
                if count == 0 {
                    self.fail(crate::Kind::IrInvalid, "limit offset>=0, count>0");
                    ir::Limit::Literal { offset, count }
                } else if root {
                    let offset_p = self.literal(offset);
                    let count_p = self.literal(count);
                    ir::Limit::Params { offset_p, count_p }
                } else {
                    ir::Limit::Literal { offset, count }
                }
            }
        });
        out.if_parent = q.if_parent.as_ref().map(|ip| ir::IfParent { column: ip.column.clone(), p: self.index(ip.p) });
        out
    }
}
