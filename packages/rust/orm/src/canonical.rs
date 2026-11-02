//! The canonical parameter walk of a request, in the order of packages/go/orm/canonical.go.
//!
//! The walk pads each IN list to its power-of-two bucket, gives every parameter reference a slot of its own
//! in walk order, and renumbers the IR from that walk alone, so the plan cache key of a request does not depend
//! on the order its parameters were built in. A parameter no reference names keeps its value after the slots.

use crate::codes;
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
    fn fail(&mut self, code: &str, msg: impl Into<String>) {
        if self.err.is_none() {
            self.err = Some(Error::Engine { code: code.into(), msg: msg.into() });
        }
    }

    /// Adds one slot holding the value of parameter p and returns its index. A reference past the parameters is
    /// IR_INVALID, which the validator would also report.
    fn index(&mut self, p: usize) -> usize {
        if p >= self.params.len() {
            self.fail(codes::IR_INVALID, format!("param index {p} out of range (n_params {})", self.params.len()));
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
        v.r#fn = p.r#fn.as_ref().map(|f| self.func(f));
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
            c.r#fn = cols
                .r#fn
                .iter()
                .map(|(k, f)| (k.clone(), ir::ColFunc { column: f.column.clone(), r#fn: self.func(&f.r#fn) }))
                .collect();
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
        out.order = q
            .order
            .iter()
            .map(|o| {
                let mut v = o.clone();
                v.r#fn = o.r#fn.as_ref().map(|f| self.func(f));
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
                    self.fail(codes::IR_INVALID, "limit offset>=0, count>0");
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

#[cfg(test)]
mod plan_cache_composite_tests {
    use super::*;
    use serde_json::{json, Value};

    fn vector() -> Value {
        serde_json::from_str(include_str!("../../../../contracts/fixtures/plan_cache_composite.json")).expect("the fixture parses")
    }

    fn params(v: &Value) -> Vec<Param> {
        v.as_array()
            .expect("the fixture params are an array")
            .iter()
            .map(|p| match p {
                Value::String(s) => Param::Str(s.clone()),
                Value::Number(n) => Param::I64(n.as_i64().expect("an integer parameter")),
                other => panic!("unexpected fixture parameter {other}"),
            })
            .collect()
    }

    fn values(ps: &[Param]) -> Vec<Value> {
        ps.iter()
            .map(|p| match p {
                Param::Str(s) => json!(s),
                Param::I64(i) => json!(i),
                other => panic!("unexpected canonical parameter {other:?}"),
            })
            .collect()
    }

    fn index(v: &Value) -> usize {
        v.as_u64().expect("a parameter index") as usize
    }

    fn indexes(v: &Value) -> Vec<usize> {
        v.as_array().expect("a list of parameter indexes").iter().map(index).collect()
    }

    // Requirements: CPX-4.
    #[test]
    fn plan_cache_composite_parameter_order() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let v = vector();
        let mut request: ir::Request = serde_json::from_value(v["request"].clone()).expect("the composite request parses");
        let mut ps = params(&v["params"]);
        canonicalize(&mut request, &mut ps).expect("the composite request canonicalizes");
        let want = &v["canonical"];
        assert_eq!(values(&ps), want["params"].as_array().expect("canonical params").clone());
        assert_eq!(request.n_params, index(&want["n_params"]));
        match &request.query.limit {
            Some(ir::Limit::Params { offset_p, count_p }) => assert_eq!((*offset_p, *count_p), (index(&want["limit"]["offset_p"]), index(&want["limit"]["count_p"]))),
            other => panic!("the root limit is not parameters: {other:?}"),
        }
        assert_eq!(request.query.if_parent.as_ref().expect("the parent condition").p, index(&want["if_parent_p"]));
        assert_eq!(request.set.iter().map(|a| a.p.expect("a set parameter")).collect::<Vec<_>>(), indexes(&want["set_p"]));
        assert_eq!(request.on_duplicate.iter().map(|a| a.p.expect("an on duplicate parameter")).collect::<Vec<_>>(), indexes(&want["on_duplicate_p"]));
        let rows: Vec<Vec<usize>> = want["rows"].as_array().expect("canonical rows").iter().map(indexes).collect();
        assert_eq!(request.rows, rows);
        assert_eq!(request.optimistic.as_ref().expect("the optimistic column").p, index(&want["optimistic_p"]));
    }

    // Requirements: CPX-4.
    #[test]
    fn plan_cache_predicate_fn_parameter_order() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let v = vector();
        let vec = &v["predicate_fn_param"];
        let mut request: ir::Request = serde_json::from_value(vec["request"].clone()).expect("the predicate request parses");
        let mut ps = params(&vec["params"]);
        canonicalize(&mut request, &mut ps).expect("the predicate request canonicalizes");
        let want = &vec["canonical"];
        assert_eq!(values(&ps), want["params"].as_array().expect("canonical params").clone());
        assert_eq!(request.n_params, index(&want["n_params"]));
        let Some(ir::Item::Pred { pred }) = request.query.where_.as_ref().and_then(|g| g.items.first()) else {
            panic!("the where group holds no predicate");
        };
        assert_eq!(pred.p, Some(index(&want["where_p"])));
        assert_eq!(pred.r#fn.as_ref().expect("the predicate function").ps, indexes(&want["fn_ps"]));
    }
}
