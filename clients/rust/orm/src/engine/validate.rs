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

pub(crate) fn validate(m: &Manifest, r: &ir::Request) -> Result<()> {
    if r.ir_version != IR_VERSION {
        return Err(err(codes::VERSION_MISMATCH, format!("ir_version {}, engine {IR_VERSION}", r.ir_version)));
    }
    if r.manifest_hash != m.manifest_hash {
        return Err(err(codes::SCHEMA_HASH_MISMATCH, format!("client {}, engine {}", r.manifest_hash, m.manifest_hash)));
    }
    if !matches!(r.kind.as_str(), "one" | "all" | "count" | "group_count" | "sum" | "avg" | "paginate" | "insert" | "update" | "delete" | "restore") {
        return Err(err(codes::IR_INVALID, format!("unknown kind {:?}", r.kind)));
    }
    let v = Validator { m, n: r.n_params };
    v.query(&r.query, false, false)?;
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
    if r.kind == "insert" || r.kind == "update" || r.kind == "restore" {
        if r.set.is_empty() && r.kind != "restore" {
            return Err(err(codes::IR_INVALID, format!("{} needs set[]", r.kind)));
        }
        for a in &r.set {
            v.assign(ent, a)?;
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

    fn query(&self, q: &ir::Query, is_join: bool, is_relation: bool) -> Result<()> {
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
                self.sub(sub, true)?;
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
            self.query(&j.query, true, false)?;
        }
        if !is_join && q.on.is_some() {
            return Err(err(codes::IR_INVALID, "on[] is only valid on join children"));
        }
        if q.on.as_ref().is_some_and(|g| g.not) || q.where_.as_ref().is_some_and(|g| g.not) {
            return Err(err(codes::IR_INVALID, "not applies to a nested group"));
        }
        if let Some(on) = &q.on {
            self.group(ent, on, &joined)?;
        }
        if let Some(w) = &q.where_ {
            self.group(ent, w, &joined)?;
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
            self.query(&r.query, false, true)?;
        }
        if !q.key_by.is_empty() && ent.field(&q.key_by).is_none() {
            return Err(unknown_column(&q.entity, &q.key_by));
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

    fn group(&self, ent: &Entity, g: &ir::Group, joined: &[(&str, &ir::Join)]) -> Result<()> {
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
                ir::Item::Pred { pred } => self.pred(ent, pred)?,
                ir::Item::Group { group } => {
                    if group.items.is_empty() {
                        return Err(err(codes::IR_INVALID, "empty group"));
                    }
                    self.group(ent, group, joined)?;
                }
            }
        }
        Ok(())
    }

    fn pred(&self, ent: &Entity, p: &ir::Pred) -> Result<()> {
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
            return self.sub(sub, false);
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
                if p.r#ref.is_none() {
                    return Err(err(codes::IR_INVALID, format!("{op} needs ref")));
                }
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

    fn sub(&self, s: &ir::Sub, scalar: bool) -> Result<()> {
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
        self.query(q, false, false)
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
