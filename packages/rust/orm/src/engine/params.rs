//! The slots that request parameters fill (ParamUses in Go engine/ir/params.go). An IR executor message has each
//! parameter in the form of its slot type (docs/spec/protocol.md §5 "Parameters"), so the client reads the type here.

use crate::ir;
use crate::schema::Manifest;
use polyspec_orm_schema::dbspec::{Entity, Field};

/// One slot that a request parameter fills: the slot's logical type (dbspec type name), and, for a column slot, the column it compares or
/// writes.
pub(crate) struct ParamUse<'m> {
    pub(crate) ty: String,
    pub(crate) column: Option<&'m Field>,
    /// A column assignment (set, rows, on_duplicate): a non-null column rejects NULL.
    pub(crate) assign: bool,
}

/// For each parameter of the validated request, in parameter order, these slots: the column compared or written, the column function's
/// result, the interval of relative time functions (seconds as f64, the rest as i32), the text of contains and contains_binary, and the parent
/// column of if_parent, and the column of optimistic.
pub(crate) fn param_uses<'m>(m: &'m Manifest, r: &ir::Request) -> Vec<Vec<ParamUse<'m>>> {
    let mut u = ParamUses { m, out: (0..r.n_params).map(|_| Vec::new()).collect() };
    u.query(&r.query, None);
    if let Some(ent) = m.model.entity(&r.query.entity) {
        for a in r.set.iter().chain(&r.on_duplicate) {
            u.assign(ent, a);
        }
        for row in &r.rows {
            for (j, &i) in row.iter().enumerate() {
                if let Some(a) = r.set.get(j) {
                    u.assigned(i, ent.field(&a.column));
                }
            }
        }
        if let Some(o) = &r.optimistic {
            u.column(o.p, ent.field(&o.column));
        }
    }
    u.out
}

struct ParamUses<'m> {
    m: &'m Manifest,
    out: Vec<Vec<ParamUse<'m>>>,
}

impl<'m> ParamUses<'m> {
    fn add(&mut self, i: usize, ty: String, column: Option<&'m Field>) {
        if let Some(list) = self.out.get_mut(i) {
            list.push(ParamUse { ty, column, assign: false });
        }
    }

    fn column(&mut self, i: usize, f: Option<&'m Field>) {
        if let Some(f) = f {
            self.add(i, f.ty.name().to_owned(), Some(f));
        }
    }

    fn assign(&mut self, ent: &'m Entity, a: &ir::Assign) {
        let f = ent.field(&a.column);
        for p in [a.plus_p, a.minus_p].into_iter().flatten() {
            self.column(p, f);
        }
        if let Some(p) = a.p {
            self.assigned(p, f);
        }
    }

    fn assigned(&mut self, i: usize, f: Option<&'m Field>) {
        if let (Some(f), Some(list)) = (f, self.out.get_mut(i)) {
            list.push(ParamUse { ty: f.ty.name().to_owned(), column: Some(f), assign: true });
        }
    }

    /// Walks q. For a relation child, the parent is its parent entity.
    fn query(&mut self, q: &ir::Query, parent: Option<&'m Entity>) {
        let m = self.m;
        let Some(ent) = m.model.entity(&q.entity) else { return };
        for g in [&q.on, &q.where_].into_iter().flatten() {
            self.group(g, ent);
        }
        if let (Some(ip), Some(parent)) = (&q.if_parent, parent) {
            self.column(ip.p, parent.field(&ip.column));
        }
        if let Some(columns) = &q.columns {
            for sub in columns.sub.values() {
                self.query(&sub.query, None);
            }
        }
        for j in &q.joins {
            self.query(&j.query, None);
        }
        for rel in &q.relations {
            self.query(&rel.query, Some(ent));
        }
    }

    fn group(&mut self, g: &ir::Group, ent: &'m Entity) {
        for item in &g.items {
            match item {
                ir::Item::Pred { pred } => self.pred(pred, ent),
                ir::Item::Group { group } => self.group(group, ent),
                ir::Item::Joined { .. } => {}
            }
        }
    }

    fn pred(&mut self, p: &ir::Pred, ent: &'m Entity) {
        if let Some(sub) = &p.sub {
            self.query(&sub.query, None);
        }
        if p.op == "tuple_in" || p.op == "tuple_not_in" {
            if !p.cols.is_empty() {
                for (k, &i) in p.ps.iter().enumerate() {
                    self.column(i, ent.field(&p.cols[k % p.cols.len()]));
                }
            }
            return;
        }
        if p.op == "fulltext" || p.op == "fulltext_boolean" {
            if let Some(i) = p.p {
                self.add(i, "text".into(), None);
            }
            return;
        }
        let f = ent.field(&p.column);
        if let Some(value) = &p.value {
            for &i in &value.ps {
                self.add(i, interval_type(&value.name).to_owned(), None);
            }
        }
        if p.op == "contains" || p.op == "contains_binary" {
            if let Some(i) = p.p {
                self.add(i, "text".into(), None);
            }
            return;
        }
        for i in p.p.into_iter().chain(p.ps.iter().copied()) {
            match &p.r#fn {
                Some(func) => {
                    let ty = function_type(&func.name, f);
                    match f {
                        Some(f) if f.ty.name() == ty => self.column(i, Some(f)),
                        _ => self.add(i, ty, None),
                    }
                }
                None => self.column(i, f),
            }
        }
    }
}

/// The type of the result of applying column function `name` to column f: the parameter compared with it and the output that selects it
/// has the column's type.
pub(crate) fn function_type(name: &str, f: Option<&Field>) -> String {
    match name {
        "day_of_week" | "year" | "month" => "i64".into(),
        "date" => "date".into(),
        _ => f.map(|f| f.ty.name().to_owned()).unwrap_or_else(|| "text".into()),
    }
}

/// The type of the interval value a relative time function takes. Seconds take a decimal number; other units take an integer.
pub(crate) fn interval_type(name: &str) -> &'static str {
    if super::dialect::value_function_unit(name) == Some("second") {
        "f64"
    } else {
        "i32"
    }
}
