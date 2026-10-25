//! A statement under construction and the rendering of a model into it.

use std::collections::{HashMap, HashSet};

use crate::core::{config, Added, CondKind, CondNode, Core, PredSpec, PredValue, RelSpec};
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
                manifest_hash: schema.hash().to_owned(),
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
        self.shape_key_with_n_params(self.params.len())
    }

    /// The plan-cache key with the count of the parent request's parameters. A split-plan probe and part
    /// retain their source parameter indices but defer the values to the parent request during execution.
    pub(crate) fn shape_key_with_n_params(&mut self, n_params: usize) -> u64 {
        self.ir.n_params = n_params;
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
        return polyspec_orm_schema::names::snake_case(&c.alias);
    }
    format!("{}_{}", c.ent.name, if many { "models" } else { "model" })
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
    if let Some(q) = query(&mut r, c, &mut f, &mut joins, true) {
        r.ir.query = q;
    }
    r.ir.n_params = r.params.len();
    r
}

pub(crate) fn validate_page_params(r: &ir::Request, params: &[Param]) -> crate::Result<()> {
    let Some(ir::Limit::Params { offset_p, count_p }) = &r.query.limit else { return Ok(()) };
    let value = |index: usize, field: &str| -> crate::Result<i64> {
        match params.get(index) {
            Some(Param::I64(value)) => Ok(*value),
            Some(_) => Err(Error::Engine { code: codes::CODEC_ENCODE.into(), msg: format!("page {field} must be an integer") }),
            None => Err(Error::Engine {
                code: codes::IR_INVALID.into(),
                msg: format!("page {field} parameter index {index} out of range (n_params {})", params.len()),
            }),
        }
    };
    let offset = value(*offset_p, "offset")?;
    let count = value(*count_p, "count")?;
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&offset) || !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&count) {
        return Err(Error::Engine { code: codes::CODEC_ENCODE.into(), msg: "page offset and count must be safe integers".into() });
    }
    if offset < 0 || count <= 0 {
        return Err(Error::Engine { code: codes::IR_INVALID.into(), msg: "limit offset>=0, count>0".into() });
    }
    Ok(())
}

fn query(r: &mut Req, c: &Core, f: &mut Frame<'_>, joins: &mut HashSet<String>, root_page: bool) -> Option<ir::Query> {
    if let Some(e) = c.err() {
        r.fail(e);
        return None;
    }
    if !c.where_.pending.is_empty() {
        r.fail(config(format!("connector {} without a following condition", c.where_.pending)));
        return None;
    }
    let mut q = ir::Query { entity: c.ent.name.to_owned(), force_index: c.index.clone(), lock: c.lock.to_owned(), ..Default::default() };
    q.columns = columns(r, c)?;
    if let Some(on) = &c.on {
        q.on = Some(group(r, on, c, f)?);
    }
    if !c.where_.items.is_empty() {
        q.where_ = Some(group(r, &c.where_.items, c, f)?);
    }
    for j in &c.joins {
        let path = f.paths[&j.child.id].clone();
        if !joins.insert(path.clone()) {
            r.fail(config(format!("join result name {} is used twice", last_segment(&path))));
            return None;
        }
        let on = if let Some(on) = &j.child.on { Some(group(r, on, &j.child, f)?) } else { None };
        let mut child = query(r, &j.child, f, joins, false)?;
        child.on = on;
        q.joins.push(ir::Join { rel: last_segment(&path), kind: j.kind.to_owned(), query: Box::new(child), left: j.left.clone(), right: j.right.clone() });
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
        } else {
            let func = o.func.as_ref().map(|func| func_ir(r, func));
            q.order.push(ir::Order { column: o.column.clone(), desc: o.desc, r#fn: func, ..Default::default() });
        }
    }
    q.group_by = c.group_by.clone();
    q.limit = c.limit.map(|(offset, count)| {
        if root_page {
            let offset_p = r.p(Param::I64(i64::from(offset)));
            let count_p = r.p(Param::I64(i64::from(count)));
            ir::Limit::Params { offset_p, count_p }
        } else {
            ir::Limit::Literal { offset, count }
        }
    });
    Some(q)
}

fn relation(r: &mut Req, rel: &RelSpec) -> Option<ir::Relation> {
    let ch = &rel.child;
    let mut f = Frame::new(ch, None);
    let mut joins = HashSet::new();
    let mut q = query(r, ch, &mut f, &mut joins, false)?;
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
        keys: ch.matches.iter().map(|&(left, right)| ir::KeyPair { left: left.into(), right: right.into() }).collect(),
    })
}

fn func_ir(r: &mut Req, f: &crate::args::Func) -> ir::Func {
    let ps = f.args.iter().map(|a| r.p(a.clone())).collect();
    ir::Func { name: f.name.to_owned(), ps }
}

fn columns(r: &mut Req, c: &Core) -> Option<Option<ir::Columns>> {
    let spec = &c.columns;
    let mut out = ir::Columns { mode: spec.mode.to_owned(), add: spec.add.clone(), remove: spec.remove.clone(), ..Default::default() };
    let mut added = spec.added.iter().collect::<Vec<_>>();
    added.sort_by_key(|(name, _)| *name);
    for (name, added) in added {
        match added {
            Added::Func(column, f) => {
                let func = func_ir(r, f);
                out.r#fn.insert(name.clone(), ir::ColFunc { column: column.clone(), r#fn: func });
            }
            Added::Sub(func) => {
                let core = func(c);
                let sub = subquery(r, &core, c.id, true)?;
                out.sub.insert(name.clone(), sub);
            }
        }
    }
    if out.mode.is_empty() && out.add.is_empty() && out.remove.is_empty() && out.r#fn.is_empty() && out.sub.is_empty() {
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
            CondKind::Group(items, not) => {
                let mut g = group(r, items, owner, f)?;
                g.conn = node.conn.to_owned();
                g.not = *not;
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
        PredValue::Fulltext(cols, value) => {
            out.cols = cols.clone();
            out.p = Some(r.p(value.clone()));
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
    let mut q = query(r, c, &mut f, &mut joins, false)?;
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

#[cfg(test)]
mod page_parameter_tests {
    use super::*;

    fn request() -> ir::Request {
        ir::Request {
            ir_version: 1,
            manifest_hash: "manifest".into(),
            kind: "all".into(),
            query: ir::Query { entity: "probe".into(), limit: Some(ir::Limit::Params { offset_p: 0, count_p: 1 }), ..Default::default() },
            n_params: 2,
            ..Default::default()
        }
    }

    #[test]
    fn paged_values_require_nonnegative_offset_and_positive_count() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        assert!(validate_page_params(&request(), &[Param::I64(0), Param::I64(1)]).is_ok());
        for (params, code) in [
            (vec![Param::Null, Param::I64(1)], codes::CODEC_ENCODE),
            (vec![Param::Bool(false), Param::I64(1)], codes::CODEC_ENCODE),
            (vec![Param::Str("0".into()), Param::I64(1)], codes::CODEC_ENCODE),
            (vec![Param::F64(1.5), Param::I64(1)], codes::CODEC_ENCODE),
            (vec![Param::I64(9_007_199_254_740_992), Param::I64(1)], codes::CODEC_ENCODE),
            (vec![Param::I64(-1), Param::I64(1)], codes::IR_INVALID),
            (vec![Param::I64(0), Param::I64(0)], codes::IR_INVALID),
            (vec![Param::I64(0)], codes::IR_INVALID),
        ] {
            assert_eq!(validate_page_params(&request(), &params).unwrap_err().code(), code);
        }
    }
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

#[cfg(test)]
mod plan_cache_tests {
    use super::*;
    use crate::args::Value;
    use crate::core::{Arg, ChainKey};
    use crate::model::{AnyModel, Entity};
    use crate::value::Param;
    use std::collections::HashSet;
    use std::sync::Arc;

    static IDENTITY_SCHEMA: Schema = Schema::new(
        include_str!("../../../../contracts/fixtures/identity_load.dbs"),
        "sha256:5b9923a69ed67de11e46bc3b825656d177d6e3664a867ca4d4d779b2677f97de",
    );
    static PROBE: Entity = Entity {
        name: "load_probe",
        schema: &IDENTITY_SCHEMA,
        new: |_| -> Box<dyn AnyModel> { unreachable!("the planner test builds no model") },
        collect: |_, _| unreachable!("the planner test collects no rows"),
    };
    const SEQ: ChainKey = ChainKey { conn: "", op: "", column: "seq", columns: &[], compare: "" };
    const FULLTEXT_BOOLEAN_LABEL: ChainKey = ChainKey { conn: "", op: "fulltext_boolean", column: "", columns: &["label"], compare: "" };

    /// One IN statement over lists of 1 to 300 values: the shape key takes one value per power-of-two bucket
    /// (1, 2, 4 ... 512), so 300 lengths give at most ten distinct plan-cache keys.
    // Requirements: CPX-4.
    #[test]
    fn in_list_keys_are_bounded_by_bucket() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let mut keys = HashSet::new();
        for n in 1..=300usize {
            let list: Vec<Param> = (0..n as i64).map(Param::I64).collect();
            let mut core = crate::core::Core::new(&PROBE);
            core.chain("", &[SEQ], vec![Arg::Value(Value::List(list))]);
            let mut req = build(&core, "all");
            assert!(req.error().is_none(), "length {n}: {:?}", req.error());
            keys.insert(req.shape_key());
        }
        assert!(keys.len() <= 10, "{} distinct plan keys for lengths 1 to 300, want at most 10", keys.len());
    }

    // Requirements: PRT-78; T236.
    #[test]
    fn paged_requests_share_one_root_limit_shape() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let mut expected_key = None;
        for page in 0..300u32 {
            let mut core = crate::core::Core::new(&PROBE);
            core.chain("", &[SEQ], vec![Arg::Value(Value::One(Param::I64(999)))]);
            core.limit(page * 20, 20);
            let mut req = build(&core, "all");
            assert!(req.error().is_none(), "page {page}: {:?}", req.error());
            assert!(matches!(req.ir.query.limit, Some(ir::Limit::Params { offset_p: 1, count_p: 2 })));
            assert_eq!(req.params, [Param::I64(999), Param::I64(i64::from(page * 20)), Param::I64(20)]);
            let key = req.shape_key();
            if let Some(expected) = expected_key {
                assert_eq!(key, expected, "page {page} changed the cached plan shape");
            } else {
                expected_key = Some(key);
            }
        }
    }

    #[test]
    fn paged_page_params_follow_sorted_subquery_names_before_the_root_page() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let mut core = crate::core::Core::new(&PROBE);
        core.add_column_sub(
            "z_sub",
            Arc::new(|_| {
                let mut child = crate::core::Core::new(&PROBE);
                child.chain("", &[SEQ], vec![Arg::Value(Value::One(Param::Str("z".into())))]);
                child.add_column("seq");
                child
            }),
        );
        core.add_column_sub(
            "a_sub",
            Arc::new(|_| {
                let mut child = crate::core::Core::new(&PROBE);
                child.chain("", &[SEQ], vec![Arg::Value(Value::One(Param::Str("a".into())))]);
                child.add_column("seq");
                child
            }),
        );
        core.limit(0, 20);
        let req = build(&core, "all");
        assert!(req.error().is_none(), "{:?}", req.error());
        assert_eq!(req.params, [Param::Str("a".into()), Param::Str("z".into()), Param::I64(0), Param::I64(20)]);
        let sub_param = |name: &str| match &req.ir.query.columns.as_ref().unwrap().sub[name].query.where_.as_ref().unwrap().items[0] {
            ir::Item::Pred { pred } => pred.p,
            _ => None,
        };
        assert_eq!(sub_param("a_sub"), Some(0));
        assert_eq!(sub_param("z_sub"), Some(1));
        assert!(matches!(req.ir.query.limit, Some(ir::Limit::Params { offset_p: 2, count_p: 3 })));
    }

    #[test]
    // Requirements: DSL-33, PRT-75.
    fn fulltext_boolean_chain_preserves_columns_and_search_parameter() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let mut core = crate::core::Core::new(&PROBE);
        core.chain("", &[FULLTEXT_BOOLEAN_LABEL], vec![Arg::Value(Value::One(Param::Str("alpha beta".into())))]);
        let req = build(&core, "all");
        assert!(req.error().is_none(), "{:?}", req.error());
        assert_eq!(req.params, [Param::Str("alpha beta".into())]);
        match &req.ir.query.where_.as_ref().expect("where").items[0] {
            ir::Item::Pred { pred } => {
                assert_eq!(pred.column, "");
                assert_eq!(pred.op, "fulltext_boolean");
                assert_eq!(pred.cols, ["label"]);
                assert_eq!(pred.p, Some(0));
            }
            other => panic!("fulltext condition became {other:?}"),
        }
    }
}
