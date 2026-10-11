//! request parameter가 채우는 slot (Go engine/ir/params.go의 ParamUses). IR executor message는 각
//! parameter를 그 slot type의 form으로 쓰므로(docs/protocol.md §5 "Parameters") client가 여기서 type을 읽는다.

use crate::ir;
use crate::schema::Manifest;
use polyspec_orm_schema::dbspec::{Entity, Field};

/// request parameter가 채우는 slot 하나: slot의 논리 type(dbspec type 이름), 그리고 column slot이면 비교하거나
/// 쓰는 column이다.
pub(crate) struct ParamUse<'m> {
    pub(crate) ty: String,
    pub(crate) column: Option<&'m Field>,
}

/// 검증한 request의 parameter마다, parameter 순서로, 그 slot들이다: 비교하거나 쓰는 column, column 함수의
/// 결과, 상대 시각 함수의 간격(초는 f64, 나머지는 i32), contains와 contains_binary의 text, if_parent의 부모
/// column, optimistic의 column이다.
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
                    u.column(i, ent.field(&a.column));
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
            list.push(ParamUse { ty, column });
        }
    }

    fn column(&mut self, i: usize, f: Option<&'m Field>) {
        if let Some(f) = f {
            self.add(i, f.ty.name().to_owned(), Some(f));
        }
    }

    fn assign(&mut self, ent: &'m Entity, a: &ir::Assign) {
        let f = ent.field(&a.column);
        for p in [a.p, a.plus_p, a.minus_p].into_iter().flatten() {
            self.column(p, f);
        }
    }

    /// q를 돈다. relation 자식이면 parent는 그 부모 entity다.
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
        let f = ent.field(&p.column);
        if let Some(value) = &p.value {
            for &i in &value.ps {
                self.add(i, super::planner::value_function_arg_type(&value.name).to_owned(), None);
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

/// column f에 column 함수 `name`을 적용한 결과의 type이다: 그것과 비교하는 parameter와 그것을 고르는 output
/// column의 type이다.
pub(crate) fn function_type(name: &str, f: Option<&Field>) -> String {
    match name {
        "day_of_week" | "year" | "month" => "i64".into(),
        "date" => "date".into(),
        _ => f.map(|f| f.ty.name().to_owned()).unwrap_or_else(|| "text".into()),
    }
}
