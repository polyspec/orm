//! Checks a request against the manifest before it is planned.

use super::dialect::{column_function_types, is_value_function, value_function_unit};
use super::err;
use crate::codes;
use crate::ir;
use crate::schema::Manifest;
use crate::Result;
use polyspec_orm_schema::dbspec::{Entity, Field};

const IR_VERSION: u32 = 1;

fn numeric(c: &Field) -> bool {
    matches!(c.ty.name(), "i16" | "i32" | "i64" | "f64" | "decimal")
}

const COMPARE: &[&str] = &["eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"];

/// equality와 목록 비교만 하는 operator.
const EQUALITY: &[&str] = &["eq", "not_eq", "in", "not_in", "is_null", "is_not_null"];

fn ops_by_type(typ: &str) -> &'static [&'static str] {
    match typ {
        "i16" | "i32" | "i64" | "f64" | "decimal" | "date" | "time" | "datetime" => COMPARE,
        "varchar" => &["eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "contains_binary", "is_null", "is_not_null"],
        "text" => &["eq", "not_eq", "gt", "gte", "lt", "lte", "contains", "contains_binary", "is_null", "is_not_null"],
        "uuid" | "bytes" => EQUALITY,
        "bool" => &["eq", "not_eq", "is_null", "is_not_null"],
        _ => &["is_null", "is_not_null"],
    }
}

fn col_op(op: &str) -> bool {
    matches!(op, "eq_col" | "not_eq_col" | "gt_col" | "gte_col" | "lt_col" | "lte_col")
}

/// column의 type과 codec stage에 operator를 쓸 수 있는지 판단한다. AES column은
/// blind index로 equality를 비교하고, `hex`와 `ip`만 쓰는 column은 같은 값이 같은
/// stored value가 되므로 equality를 비교한다.
fn op_allowed(c: &Field, op: &str) -> bool {
    if col_op(op) {
        return true;
    }
    if !c.codec.is_empty() {
        if c.aes() || c.codec.iter().all(|s| s == "hex" || s == "ip") {
            return EQUALITY.contains(&op);
        }
        return matches!(op, "is_null" | "is_not_null");
    }
    ops_by_type(c.ty.name()).contains(&op)
}

fn unknown_column(ent: &str, col: &str) -> crate::Error {
    err(codes::COLUMN_UNKNOWN, format!("{ent}.{col}"))
}

pub(crate) struct Validator<'m> {
    m: &'m Manifest,
    n: usize,
}

/// statement 안의 entity 자리 하나(root나 join)다. planner의 scope처럼 column-to-column 조건의
/// ref path를 푼다. relation과 subquery는 자기 statement의 root다. manifest에 없는 entity의 ent는 None이다.
struct Scope<'m> {
    name: String,
    ent: Option<&'m Entity>,
    joins: Vec<(String, Scope<'m>)>,
}

/// 조건이 놓인 자리다: root는 statement의 root scope, outer는 subquery를 둘러싼 query의 scope
/// (subquery가 아니면 None), node는 조건의 scope다.
#[derive(Clone, Copy)]
struct At<'a, 'm> {
    root: &'a Scope<'m>,
    outer: Option<&'a Scope<'m>>,
    node: &'a Scope<'m>,
}

pub(crate) fn validate(m: &Manifest, r: &ir::Request) -> Result<()> {
    if r.ir_version != IR_VERSION {
        return Err(err(codes::VERSION_MISMATCH, format!("ir_version {}, engine {IR_VERSION}", r.ir_version)));
    }
    if r.manifest_hash != m.manifest_hash {
        return Err(err(codes::SCHEMA_HASH_MISMATCH, format!("client {}, engine {}", r.manifest_hash, m.manifest_hash)));
    }
    if !matches!(
        r.kind.as_str(),
        "one" | "all" | "count" | "group_count" | "sum" | "avg" | "paginate" | "insert" | "update" | "delete" | "restore" | "restart_identity"
    ) {
        return Err(err(codes::IR_INVALID, format!("unknown kind {:?}", r.kind)));
    }
    if r.load && (r.kind != "insert" || !r.on_duplicate.is_empty()) {
        return Err(err(codes::IR_INVALID, "load is only valid on insert without on_duplicate"));
    }
    // restart_identity은 entity 하나의 identity만 다시 시작하므로 행이나 값을 받지 않는다.
    if r.kind == "restart_identity"
        && (!r.set.is_empty() || !r.rows.is_empty() || !r.on_duplicate.is_empty() || r.query.where_.is_some() || r.optimistic.is_some())
    {
        return Err(err(codes::IR_INVALID, "restart_identity takes no set, rows, on_duplicate, where or optimistic"));
    }
    let v = Validator { m, n: r.n_params };
    let root = v.scopes(&r.query);
    v.query(&r.query, At { root: &root, outer: None, node: &root }, false, false)?;
    let q = &r.query;
    if !q.lock.is_empty() && r.kind != "one" && r.kind != "all" {
        return Err(err(codes::IR_INVALID, "row lock is only valid on one or all"));
    }
    let ent = m.entity(&q.entity)?;
    if r.kind == "sum" || r.kind == "avg" {
        let c = ent.field(&r.agg).ok_or_else(|| unknown_column(&q.entity, &r.agg))?;
        if !numeric(c) {
            return Err(err(codes::OPERATOR_NOT_ALLOWED, format!("{} on {}.{} ({})", r.kind, q.entity, r.agg, c.ty.render())));
        }
    }
    if r.kind == "group_count" && q.group_by.is_empty() {
        return Err(err(codes::IR_INVALID, "group_count needs group_by"));
    }
    if !q.group_by.is_empty() && r.kind != "count" && r.kind != "group_count" {
        return Err(err(codes::IR_INVALID, format!("group_by is only valid on count or group_count, not {}", r.kind)));
    }
    if r.kind == "insert" || r.kind == "update" || r.kind == "restore" {
        if r.set.is_empty() && r.kind != "restore" {
            return Err(err(codes::IR_INVALID, format!("{} needs set[]", r.kind)));
        }
        for a in &r.set {
            v.assign(ent, a)?;
            // A VALUES list has no current row for plus_p or minus_p to read; on_duplicate does.
            if r.kind == "insert" && (a.plus_p.is_some() || a.minus_p.is_some()) {
                return Err(err(codes::IR_INVALID, format!("insert cannot assign {} by plus or minus", a.column)));
            }
            // The key and the soft delete column are the table's own: a restore clears the latter itself.
            if r.kind == "update" || r.kind == "restore" {
                let c = ent.field(&a.column).ok_or_else(|| unknown_column(&r.query.entity, &a.column))?;
                if c.primary_key || c.identity || (r.kind == "restore" && ent.soft_delete.as_deref() == Some(a.column.as_str())) {
                    return Err(err(codes::IR_INVALID, format!("cannot update {}", a.column)));
                }
            }
        }
    }
    if !r.rows.is_empty() {
        if r.kind != "insert" || !r.on_duplicate.is_empty() {
            return Err(err(codes::IR_INVALID, "rows are only valid on insert without on_duplicate"));
        }
        for a in &r.set {
            if a.p.is_none() {
                return Err(err(codes::IR_INVALID, format!("multi-row insert assigns {}.{} without a value", q.entity, a.column)));
            }
        }
        for (i, row) in r.rows.iter().enumerate() {
            if row.len() != r.set.len() {
                return Err(err(codes::IR_INVALID, format!("insert row {} has {} values for {} columns", i + 1, row.len(), r.set.len())));
            }
            v.params(row)?;
        }
    }
    if !r.on_duplicate.is_empty() {
        if r.kind != "insert" {
            return Err(err(codes::IR_INVALID, "on_duplicate is only valid on insert"));
        }
        for a in &r.on_duplicate {
            v.assign(ent, a)?;
            let c = ent.field(&a.column).ok_or_else(|| unknown_column(&q.entity, &a.column))?;
            if c.primary_key || c.identity {
                return Err(err(codes::IR_INVALID, format!("on_duplicate cannot assign {}.{}", q.entity, a.column)));
            }
        }
    }
    if let Some(o) = &r.optimistic {
        if ent.field(&o.column).is_none() {
            return Err(unknown_column(&q.entity, &o.column));
        }
        v.params(&[o.p])?;
    }
    if (r.kind == "update" || r.kind == "delete" || r.kind == "restore") && q.where_.as_ref().map(|g| g.items.is_empty()).unwrap_or(true) {
        return Err(err(codes::IR_INVALID, format!("{} without where", r.kind)));
    }
    // restore는 지워진 행만 고치므로 읽은 version과 비교할 것이 없다.
    if r.kind == "restore" && r.optimistic.is_some() {
        return Err(err(codes::IR_INVALID, "restore takes no optimistic"));
    }
    Ok(())
}

impl<'m> Validator<'m> {
    fn params(&self, ps: &[usize]) -> Result<()> {
        for &i in ps {
            if i >= self.n {
                return Err(err(codes::IR_INVALID, format!("param index {i} out of range (n_params {})", self.n)));
            }
        }
        Ok(())
    }

    fn assign(&self, ent: &Entity, a: &ir::Assign) -> Result<()> {
        let c = ent.field(&a.column).ok_or_else(|| unknown_column(&ent.name, &a.column))?;
        let n = [a.p.is_some(), a.null, a.plus_p.is_some(), a.minus_p.is_some()].iter().filter(|x| **x).count();
        if n != 1 {
            return Err(err(codes::IR_INVALID, format!("set {}: exactly one of p/null/plus_p/minus_p", a.column)));
        }
        if a.null && !c.nullable {
            return Err(err(codes::IR_INVALID, format!("set {}.{} to null but column is NOT NULL", ent.name, a.column)));
        }
        if (a.plus_p.is_some() || a.minus_p.is_some()) && !numeric(c) {
            return Err(err(codes::OPERATOR_NOT_ALLOWED, format!("plus/minus on {}.{} ({})", ent.name, a.column, c.ty.render())));
        }
        let singles: Vec<usize> = [a.p, a.plus_p, a.minus_p].into_iter().flatten().collect();
        self.params(&singles)
    }

    /// q와 그 join의 scope tree다. planner의 build_scopes처럼 조건을 검사하기 전에 모든 join을
    /// 두므로, 조건은 뒤에 선언한 join의 path도 푼다.
    fn scopes(&self, q: &ir::Query) -> Scope<'m> {
        let mut s = Scope { name: q.entity.clone(), ent: self.m.entity(&q.entity).ok(), joins: Vec::new() };
        for j in &q.joins {
            if !s.joins.iter().any(|(n, _)| *n == j.rel) {
                s.joins.push((j.rel.clone(), self.scopes(&j.query)));
            }
        }
        s
    }

    /// planner의 resolve_path처럼 column-to-column 조건의 ref를 푼다. path ""는 statement의 root,
    /// "^"는 subquery를 둘러싼 query이며 subquery 안에서만 쓴다. 그 밖의 path는 root에서 join 이름을
    /// "/"로 이은 것이다. 대상 entity에 ref의 column이 있어야 한다.
    fn column_ref(&self, at: At<'_, 'm>, r: &ir::ColRef) -> Result<()> {
        let mut target = at.root;
        if r.path == "^" {
            target = at.outer.ok_or_else(|| err(codes::IR_INVALID, "^ reference outside a subquery"))?;
        } else if !r.path.is_empty() {
            for seg in r.path.split('/') {
                target = target
                    .joins
                    .iter()
                    .find(|(n, _)| n == seg)
                    .map(|(_, s)| s)
                    .ok_or_else(|| err(codes::ENTITY_NOT_JOINED, format!("{}.{seg}", target.name)))?;
            }
        }
        let ent = target.ent.ok_or_else(|| err(codes::ENTITY_UNKNOWN, target.name.clone()))?;
        if ent.field(&r.column).is_none() {
            return Err(unknown_column(&target.name, &r.column));
        }
        Ok(())
    }

    fn query(&self, q: &ir::Query, at: At<'_, 'm>, is_join: bool, is_relation: bool) -> Result<()> {
        let ent = self.m.entity(&q.entity)?;
        if let Some(c) = &q.columns {
            if !matches!(c.mode.as_str(), "" | "all" | "none") {
                return Err(err(codes::IR_INVALID, format!("columns.mode {:?}", c.mode)));
            }
            for name in c.add.iter().chain(&c.remove) {
                if ent.field(name).is_none() {
                    return Err(unknown_column(&q.entity, name));
                }
            }
            let output = |name: &str, outputs: &mut Vec<String>| -> Result<()> {
                if ent.field(name).is_some() || outputs.iter().any(|o| o == name) {
                    return Err(err(codes::COLUMN_ALIAS_CONFLICT, format!("{}.{name} is already a row name", q.entity)));
                }
                outputs.push(name.to_owned());
                Ok(())
            };
            let mut names = Vec::new();
            for (name, f) in &c.r#fn {
                output(name, &mut names)?;
                let col = ent.field(&f.column).ok_or_else(|| unknown_column(&q.entity, &f.column))?;
                self.column_func(ent, col, &f.r#fn)?;
            }
            for (name, sub) in &c.sub {
                output(name, &mut names)?;
                self.sub(sub, true, at.node)?;
            }
        }
        let mut joined: Vec<(&str, &ir::Join)> = Vec::new();
        for j in &q.joins {
            if j.kind != "inner" && j.kind != "left" {
                return Err(err(codes::IR_INVALID, format!("join kind {:?}", j.kind)));
            }
            if j.rel.is_empty() || joined.iter().any(|(n, _)| *n == j.rel) {
                return Err(err(codes::IR_INVALID, format!("join name {:?} is empty or used twice", j.rel)));
            }
            if j.left.is_empty() || j.right.is_empty() {
                return Err(err(codes::IR_INVALID, format!("join {}: left, right and query are required", j.rel)));
            }
            let target = self.m.entity(&j.query.entity)?;
            if ent.field(&j.left).is_none() {
                return Err(unknown_column(&ent.name, &j.left));
            }
            if target.field(&j.right).is_none() {
                return Err(unknown_column(&target.name, &j.right));
            }
            joined.push((&j.rel, j));
            let node = at
                .node
                .joins
                .iter()
                .find(|(n, _)| *n == j.rel)
                .map(|(_, s)| s)
                .ok_or_else(|| err(codes::IR_INVALID, format!("join {} has no scope", j.rel)))?;
            self.query(&j.query, At { node, ..at }, true, false)?;
        }
        if !is_join && q.on.is_some() {
            return Err(err(codes::IR_INVALID, "on[] is only valid on join children"));
        }
        if q.on.as_ref().is_some_and(|g| g.not) || q.where_.as_ref().is_some_and(|g| g.not) {
            return Err(err(codes::IR_INVALID, "not applies to a nested group"));
        }
        // top-level group은 앞 형제가 없으므로 conn을 갖지 않는다.
        for top in [&q.on, &q.where_].into_iter().flatten() {
            if !top.conn.is_empty() {
                return Err(err(codes::IR_INVALID, format!("the top-level group takes no conn ({:?})", top.conn)));
            }
        }
        if let Some(on) = &q.on {
            self.group(at, on, &joined)?;
        }
        if let Some(w) = &q.where_ {
            self.group(at, w, &joined)?;
            let mut seen = Vec::new();
            joined_refs(w, &mut seen)?;
        }
        let mut relation_names: Vec<&str> = Vec::new();
        for r in &q.relations {
            if r.rel.is_empty() || relation_names.contains(&r.rel.as_str()) {
                return Err(err(codes::COLUMN_ALIAS_CONFLICT, format!("relation name {:?} is empty or used twice", r.rel)));
            }
            relation_names.push(&r.rel);
            if ent.field(&r.rel).is_some() {
                return Err(err(codes::COLUMN_ALIAS_CONFLICT, format!("{}.{} is already a column", q.entity, r.rel)));
            }
            if r.keys.is_empty() || (r.kind != "one" && r.kind != "many") {
                return Err(err(codes::IR_INVALID, format!("relation {}: keys and kind one|many are required", r.rel)));
            }
            let target = self.m.entity(&r.query.entity)?;
            let (mut lefts, mut rights) = (Vec::new(), Vec::new());
            for k in &r.keys {
                if k.left.is_empty() || k.right.is_empty() {
                    return Err(err(codes::IR_INVALID, format!("relation {}: every key needs left and right", r.rel)));
                }
                if ent.field(&k.left).is_none() {
                    return Err(unknown_column(&q.entity, &k.left));
                }
                if target.field(&k.right).is_none() {
                    return Err(unknown_column(&target.name, &k.right));
                }
                // 한 column이 두 성분에 나오면 key가 아니다.
                if lefts.contains(&k.left) || rights.contains(&k.right) {
                    return Err(err(codes::IR_INVALID, format!("relation {}: key column {} or {} is used twice", r.rel, k.left, k.right)));
                }
                lefts.push(k.left.clone());
                rights.push(k.right.clone());
            }
            let kind = r.kind.clone();
            if r.query.limit.is_some() {
                return Err(err(codes::LIMIT_IN_RELATION, format!("{}: use limit_per_parent", r.rel)));
            }
            if r.query.flatten && kind != "one" {
                return Err(err(codes::IR_INVALID, format!("relation {}: flatten needs a one relation", r.rel)));
            }
            if !r.query.key_by.is_empty() && kind != "many" {
                return Err(err(codes::IR_INVALID, format!("relation {}: key_by needs a many relation", r.rel)));
            }
            if let Some(ip) = &r.query.if_parent {
                if ent.field(&ip.column).is_none() {
                    return Err(err(codes::COLUMN_UNKNOWN, format!("{}.{} (if_parent)", q.entity, ip.column)));
                }
            }
            let scope = self.scopes(&r.query);
            self.query(&r.query, At { root: &scope, outer: None, node: &scope }, false, true)?;
        }
        if !q.key_by.is_empty() {
            let key_column = ent.field(&q.key_by).ok_or_else(|| unknown_column(&q.entity, &q.key_by))?;
            // A NULL collection key has no answer that every language shares.
            if key_column.nullable {
                return Err(err(codes::IR_INVALID, format!("key_by {} is nullable", q.key_by)));
            }
        }
        if let Some(ip) = &q.if_parent {
            self.params(&[ip.p])?;
        }
        if !is_relation && (!q.key_by.is_empty() || q.flatten || q.limit_per_parent > 0 || q.if_parent.is_some() || q.no_cascade_delete) {
            return Err(err(codes::IR_INVALID, format!("relation-only options on {}", q.entity)));
        }
        for o in &q.order {
            let kinds = [!o.column.is_empty(), o.random].iter().filter(|x| **x).count();
            if kinds != 1 {
                return Err(err(codes::IR_INVALID, "order needs exactly one of column, random"));
            }
            if !o.column.is_empty() {
                let col = ent.field(&o.column).ok_or_else(|| unknown_column(&q.entity, &o.column))?;
                if let Some(f) = &o.r#fn {
                    self.column_func(ent, col, f)?;
                }
            } else if o.r#fn.is_some() {
                return Err(err(codes::IR_INVALID, "order function needs a column"));
            }
        }
        for g in &q.group_by {
            if ent.field(g).is_none() {
                return Err(unknown_column(&q.entity, g));
            }
        }
        if !q.group_by.is_empty() {
            // The request's own query is the only one that may group: a join, a relation and a subquery have an outer.
            if is_join || is_relation || at.outer.is_some() {
                return Err(err(codes::IR_INVALID, "group_by is only valid on the request's root query"));
            }
            // An order item of a grouped query sorts the groups: only a group column (or random) has a value per group.
            for o in &q.order {
                if !o.column.is_empty() && !q.group_by.contains(&o.column) {
                    return Err(err(codes::IR_INVALID, format!("order by {}, which is not a group column", o.column)));
                }
            }
        }
        if let Some(l) = &q.limit {
            if l.count == 0 {
                return Err(err(codes::IR_INVALID, "limit offset>=0, count>0"));
            }
        }
        if !q.lock.is_empty() {
            if !matches!(q.lock.as_str(), "update" | "share" | "update_nowait" | "share_nowait") {
                return Err(err(codes::IR_INVALID, format!("lock {:?}: want update, share, update_nowait or share_nowait", q.lock)));
            }
            if is_join || is_relation || !q.group_by.is_empty() || q.limit_per_parent > 0 {
                return Err(err(codes::IR_INVALID, "row lock is only valid on a root row select"));
            }
        }
        if !q.force_index.is_empty() && !ent.indexes.iter().chain(&ent.uniques).any(|k| k.name == q.force_index) {
            return Err(err(codes::INDEX_UNKNOWN, format!("{}.{}", q.entity, q.force_index)));
        }
        Ok(())
    }

    fn group(&self, at: At<'_, 'm>, g: &ir::Group, joined: &[(&str, &ir::Join)]) -> Result<()> {
        for (i, it) in g.items.iter().enumerate() {
            let conn = match it {
                ir::Item::Pred { pred } => &pred.conn,
                ir::Item::Group { group } => &group.conn,
                ir::Item::Joined { joined } => &joined.conn,
            };
            if !matches!(conn.as_str(), "" | "and" | "or") {
                return Err(err(codes::IR_INVALID, format!("conn {conn:?}")));
            }
            if i == 0 && conn == "or" {
                return Err(err(codes::OR_AT_GROUP_START, "a group may not start with OR"));
            }
            // group의 첫 item은 앞 형제가 없으므로 conn을 갖지 않는다.
            if i == 0 && !conn.is_empty() {
                return Err(err(codes::IR_INVALID, format!("the first item of a group takes no conn ({conn:?})")));
            }
            match it {
                ir::Item::Joined { joined: j } => {
                    let (_, join) = joined
                        .iter()
                        .find(|(n, _)| *n == j.join)
                        .ok_or_else(|| err(codes::ENTITY_NOT_JOINED, format!("{} is not joined in this statement", j.join)))?;
                    if join.query.where_.as_ref().map(|w| w.items.is_empty()).unwrap_or(true) {
                        return Err(err(codes::IR_INVALID, format!("joined {} has no conditions", j.join)));
                    }
                }
                ir::Item::Pred { pred } => self.pred(at, pred)?,
                ir::Item::Group { group } => {
                    if group.items.is_empty() {
                        return Err(err(codes::IR_INVALID, "empty group"));
                    }
                    self.group(at, group, joined)?;
                }
            }
        }
        Ok(())
    }

    fn pred(&self, at: At<'_, 'm>, p: &ir::Pred) -> Result<()> {
        let ent = at.node.ent.ok_or_else(|| err(codes::ENTITY_UNKNOWN, at.node.name.clone()))?;
        self.params(&p.ps)?;
        if let Some(i) = p.p {
            self.params(&[i])?;
        }
        if p.op == "tuple_in" || p.op == "tuple_not_in" {
            if p.cols.len() < 2 {
                return Err(err(codes::IR_INVALID, format!("{} needs at least two columns", p.op)));
            }
            for name in &p.cols {
                let c = ent.field(name).ok_or_else(|| unknown_column(&ent.name, name))?;
                if !c.codec.is_empty() {
                    return Err(err(codes::OPERATOR_NOT_ALLOWED, format!("{} on {}.{name}", p.op, ent.name)));
                }
            }
            if p.ps.is_empty() {
                return Err(err(codes::EMPTY_IN, format!("{}({})", ent.name, p.cols.join(","))));
            }
            if !p.ps.len().is_multiple_of(p.cols.len()) {
                return Err(err(codes::IR_INVALID, format!("{}: {} values for {} columns", p.op, p.ps.len(), p.cols.len())));
            }
            return Ok(());
        }
        if !p.cols.is_empty() {
            return Err(err(codes::IR_INVALID, "cols is only valid with tuple_in or tuple_not_in"));
        }
        if let Some(sub) = &p.sub {
            if ent.field(&p.column).is_none() {
                return Err(unknown_column(&ent.name, &p.column));
            }
            if p.op != "in" && p.op != "not_in" {
                return Err(err(codes::IR_INVALID, "subquery needs in or not_in"));
            }
            if p.p.is_some() || !p.ps.is_empty() || p.r#fn.is_some() || p.value.is_some() {
                return Err(err(codes::IR_INVALID, "subquery pred may not carry values"));
            }
            return self.sub(sub, false, at.node);
        }
        if p.r#fn.is_some() || p.value.is_some() {
            let c = ent.field(&p.column).ok_or_else(|| unknown_column(&ent.name, &p.column))?;
            if p.r#fn.is_some() && p.value.is_some() {
                return Err(err(codes::IR_INVALID, "fn and value cannot be combined"));
            }
            if let Some(f) = &p.r#fn {
                self.column_func(ent, c, f)?;
                return match p.op.as_str() {
                    "eq" | "not_eq" | "gt" | "gte" | "lt" | "lte" if p.p.is_none() => Err(err(codes::IR_INVALID, format!("{} needs a value (p)", p.op))),
                    "eq" | "not_eq" | "gt" | "gte" | "lt" | "lte" => Ok(()),
                    "in" | "not_in" if p.ps.is_empty() => Err(err(codes::EMPTY_IN, format!("{}.{}", ent.name, p.column))),
                    "in" | "not_in" => Ok(()),
                    "between" if p.ps.len() != 2 => Err(err(codes::IR_INVALID, "between needs 2 params (ps)")),
                    "between" => Ok(()),
                    op => Err(err(codes::OPERATOR_NOT_ALLOWED, format!("{op} with a column function"))),
                };
            }
            let v = p.value.as_ref().unwrap();
            if !is_value_function(&v.name) {
                return Err(err(codes::FUNCTION_UNKNOWN, v.name.clone()));
            }
            if !matches!(c.ty.name(), "date" | "datetime") {
                return Err(err(codes::OPERATOR_NOT_ALLOWED, format!("{} on {}.{} ({})", v.name, ent.name, p.column, c.ty.render())));
            }
            let want = usize::from(value_function_unit(&v.name).is_some());
            if v.ps.len() != want {
                return Err(err(codes::IR_INVALID, format!("{} takes {want} arguments", v.name)));
            }
            if p.p.is_some() || !p.ps.is_empty() {
                return Err(err(codes::IR_INVALID, "value function pred may not carry p or ps"));
            }
            if !matches!(p.op.as_str(), "eq" | "not_eq" | "gt" | "gte" | "lt" | "lte") {
                return Err(err(codes::OPERATOR_NOT_ALLOWED, format!("{} with a value function", p.op)));
            }
            return self.params(&v.ps);
        }
        let c = ent.field(&p.column).ok_or_else(|| unknown_column(&ent.name, &p.column))?;
        if !op_allowed(c, &p.op) {
            return Err(err(codes::OPERATOR_NOT_ALLOWED, format!("{} on {}.{} ({})", p.op, ent.name, p.column, c.ty.render())));
        }
        match p.op.as_str() {
            "is_null" | "is_not_null" => {}
            "in" | "not_in" => {
                if p.ps.is_empty() {
                    return Err(err(codes::EMPTY_IN, format!("{}.{}", ent.name, p.column)));
                }
            }
            "between" => {
                if p.ps.len() != 2 {
                    return Err(err(codes::IR_INVALID, "between needs 2 params (ps)"));
                }
            }
            op if col_op(op) => {
                let r = p.r#ref.as_ref().ok_or_else(|| err(codes::IR_INVALID, format!("{op} needs ref")))?;
                self.column_ref(at, r)?;
            }
            op => {
                if p.p.is_none() {
                    return Err(err(codes::IR_INVALID, format!("{op} {}.{} needs a value (p)", ent.name, p.column)));
                }
            }
        }
        Ok(())
    }

    fn column_func(&self, ent: &Entity, c: &Field, f: &ir::Func) -> Result<()> {
        let types = column_function_types(&f.name).ok_or_else(|| err(codes::FUNCTION_UNKNOWN, f.name.clone()))?;
        if !types.contains(&c.ty.name()) {
            return Err(err(codes::OPERATOR_NOT_ALLOWED, format!("{} on {}.{} ({})", f.name, ent.name, c.name, c.ty.render())));
        }
        if !f.ps.is_empty() {
            return Err(err(codes::IR_INVALID, format!("{} takes no arguments", f.name)));
        }
        Ok(())
    }

    /// subquery를 검사한다. outer는 subquery가 놓인 scope이며 그 "^" ref가 가리킨다.
    fn sub(&self, s: &ir::Sub, scalar: bool, outer: &Scope<'m>) -> Result<()> {
        let ent = self.m.entity(&s.query.entity)?;
        match s.agg.as_str() {
            "" => {
                if s.column.is_empty() {
                    return Err(err(codes::IR_INVALID, "subquery needs a column"));
                }
            }
            "sum" | "avg" => {
                if !scalar {
                    return Err(err(codes::IR_INVALID, format!("{} subquery is only valid as a column", s.agg)));
                }
                let c = ent.field(&s.column).ok_or_else(|| unknown_column(&ent.name, &s.column))?;
                if !numeric(c) {
                    return Err(err(codes::OPERATOR_NOT_ALLOWED, format!("{} on {}.{} ({})", s.agg, ent.name, s.column, c.ty.render())));
                }
            }
            "count" => {
                if !scalar {
                    return Err(err(codes::IR_INVALID, "count subquery is only valid as a column"));
                }
            }
            other => return Err(err(codes::IR_INVALID, format!("subquery agg {other:?}"))),
        }
        if !s.column.is_empty() && ent.field(&s.column).is_none() {
            return Err(unknown_column(&ent.name, &s.column));
        }
        let q = &s.query;
        if q.limit.is_some() || !q.relations.is_empty() || !q.lock.is_empty() || q.columns.is_some() {
            return Err(err(codes::IR_INVALID, "subquery may not use limit, relations, lock or columns"));
        }
        let scope = self.scopes(q);
        self.query(q, At { root: &scope, outer: Some(outer), node: &scope }, false, false)
    }
}

/// Each join placed by a group appears once.
fn joined_refs<'g>(g: &'g ir::Group, seen: &mut Vec<&'g str>) -> Result<()> {
    for it in &g.items {
        match it {
            ir::Item::Joined { joined } => {
                if seen.contains(&joined.join.as_str()) {
                    return Err(err(codes::IR_INVALID, format!("joined {} is placed twice", joined.join)));
                }
                seen.push(&joined.join);
            }
            ir::Item::Group { group } => joined_refs(group, seen)?,
            ir::Item::Pred { .. } => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::coverage_planner::{bench, request, REJECTED};
    use super::validate;
    use serde_json::Value;

    /// 공유 검증 case(tests/ir/validate.json)를 읽는다. 각 request에 schema의 manifest_hash를 더해
    /// 검증기에만 주고, 받아들이는지나 기대한 오류 code로 실패하는지 본다.
    #[test]
    fn validate_vectors() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let path = polyspec_orm_testcase::manifest_dir().join("../../../tests/ir/validate.json");
        let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("validate.json")).expect("validate.json is JSON");
        assert_eq!(file["schema"], "schema/bench.dbs", "validate.json schema");
        let cases = file["cases"].as_array().expect("cases");
        assert!(!cases.is_empty(), "validate.json has no cases");
        let manifest = bench();
        let mut wrong = Vec::new();
        for c in cases {
            let name = c["name"].as_str().expect("name");
            // typed request가 담을 수 없는 member type은 request를 만들 수 없으므로 IR_INVALID다(REJECTED).
            let built = std::panic::catch_unwind(|| request(&c["request"], &manifest.manifest_hash));
            let got: std::result::Result<(), String> = match built {
                Ok(r) => validate(&manifest, &r).map_err(|e| e.code().to_owned()),
                Err(payload) => {
                    let message = payload.downcast_ref::<String>().cloned().unwrap_or_default();
                    match message.strip_prefix(REJECTED) {
                        Some(_) => Err("IR_INVALID".to_owned()),
                        None => std::panic::resume_unwind(payload),
                    }
                }
            };
            match (&got, c["valid"].as_bool().unwrap_or(false), c["error"].as_str()) {
                (Ok(()), true, None) => {}
                (Err(code), false, Some(want)) if code == want => {}
                _ => wrong.push(format!("{name}: got {got:?}, want {}", c.get("error").cloned().unwrap_or(Value::from("valid")))),
            }
        }
        assert!(wrong.is_empty(), "Rust validate vectors:\n{}", wrong.join("\n"));
    }
}
