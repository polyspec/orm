//! The unique keys, indexes, foreign keys, checks and triggers of a plan diff
//! (docs/plans.md, "Diff"): objects compare by name and definition, with the
//! source definition read through the renames.

use super::emit::emit_expr;
use super::model::{Expr, ForeignKey, Name, Operand};
use super::plan_diff::{renamed_or, ObjectRef, PlanDiff};
use super::render::{Dialect, Renderer};
use std::collections::{BTreeMap, BTreeSet};

type Renames<'d> = BTreeMap<&'d str, BTreeMap<&'d str, &'d str>>;

impl<'d> PlanDiff<'d> {
    /// unique, index, foreign key, check를 이름과 정의로 비교한다. source 정의는
    /// rename을 적용해 target 이름으로 읽는다.
    pub(crate) fn objects(&mut self, renamed_from: &BTreeMap<&'d str, &'d str>, renamed_column: &Renames<'d>) {
        let target_table = |s: &'d str| renamed_or(Some(renamed_from), s);
        // column rename을 적용한 source column 이름
        let column = |target: &str, c: &'d str| renamed_or(renamed_column.get(target), c);
        // "table.column" target 이름
        let altered_column: BTreeSet<String> = self.altered.iter().flat_map(|(t, cols)| cols.iter().map(move |c| format!("{t}.{c}"))).collect();
        let renamed_col: BTreeSet<String> = renamed_column.iter().flat_map(|(t, m)| m.values().map(move |c| format!("{t}.{c}"))).collect();
        for name in self.matched.clone() {
            let (src, tgt) = (self.source[self.table_of[name]], self.target[name]);
            let source_name: &'d str = &src.name.text;
            let renamed = |c: &'d str| column(name, c);
            // 지우는 index나 unique 위의 foreign key는 MySQL이 그 index를 지우지 못하게
            // 하므로 함께 다시 만든다.
            let mut dropped_keys: BTreeSet<String> = BTreeSet::new();
            // unique
            for u in &src.uniques {
                let def = names_def(&u.columns, renamed);
                if tgt.uniques.iter().find(|t| t.name.text == u.name.text).is_none_or(|t| names_def(&t.columns, same) != def) {
                    self.drop_objects.entry(source_name).or_default().push(ObjectRef { kind: "unique", name: &u.name.text });
                    dropped_keys.insert(def);
                }
            }
            for u in &tgt.uniques {
                if src.uniques.iter().find(|s| s.name.text == u.name.text).is_none_or(|s| names_def(&s.columns, renamed) != names_def(&u.columns, same)) {
                    self.add_objects.entry(name).or_default().push(ObjectRef { kind: "unique", name: &u.name.text });
                }
            }
            // index
            for x in &src.indexes {
                if tgt.indexes.iter().find(|t| t.name.text == x.name.text).is_none_or(|t| index_def(&x.columns, renamed) != index_def(&t.columns, same)) {
                    self.drop_objects.entry(source_name).or_default().push(ObjectRef { kind: "index", name: &x.name.text });
                    dropped_keys.insert(x.columns.iter().map(|(c, _)| renamed(&c.text)).collect::<Vec<_>>().join(","));
                }
            }
            for x in &tgt.indexes {
                if src.indexes.iter().find(|s| s.name.text == x.name.text).is_none_or(|s| index_def(&s.columns, renamed) != index_def(&x.columns, same)) {
                    self.add_objects.entry(name).or_default().push(ObjectRef { kind: "index", name: &x.name.text });
                }
            }
            // foreign key
            let forced_fk = |cols: &[&str], parent: &str, refs: &[&str]| {
                cols.iter().any(|c| altered_column.contains(&format!("{name}.{c}")))
                    || refs.iter().any(|c| altered_column.contains(&format!("{parent}.{c}")))
                    || dropped_keys.iter().any(|k| format!("{k},").starts_with(&format!("{},", cols.join(","))))
            };
            // rename을 적용한 source foreign key의 column, parent, reference
            let source_fk = |f: &'d ForeignKey| {
                let parent = target_table(&f.table.text);
                let cols: Vec<&str> = f.columns.iter().map(|c| renamed(&c.text)).collect();
                let refs: Vec<&str> = f.references.iter().map(|c| column(parent, &c.text)).collect();
                (cols, parent, refs)
            };
            for f in &src.foreign_keys {
                let (cols, parent, refs) = source_fk(f);
                let keep =
                    tgt.foreign_keys.iter().find(|t| t.name.text == f.name.text).is_some_and(|t| {
                        foreign_key_def(&cols, parent, &refs, f) == foreign_key_def(&names(&t.columns), &t.table.text, &names(&t.references), t)
                    });
                if !keep || forced_fk(&cols, parent, &refs) {
                    self.drop_objects.entry(source_name).or_default().push(ObjectRef { kind: "foreign_key", name: &f.name.text });
                }
            }
            for f in &tgt.foreign_keys {
                let keep = src.foreign_keys.iter().find(|s| s.name.text == f.name.text).is_some_and(|s| {
                    let (cols, parent, refs) = source_fk(s);
                    foreign_key_def(&cols, parent, &refs, s) == foreign_key_def(&names(&f.columns), &f.table.text, &names(&f.references), f)
                        && !forced_fk(&cols, parent, &refs)
                });
                if !keep {
                    self.add_objects.entry(name).or_default().push(ObjectRef { kind: "foreign_key", name: &f.name.text });
                }
            }
            // check: 이름 바뀐 column이나 바뀐 column을 쓰는 check는 다시 만든다.
            let forced_check = |e: &Expr| {
                let mut columns = Vec::new();
                e.columns(&mut columns);
                columns.iter().any(|c| {
                    let key = format!("{name}.{}", c.text);
                    renamed_col.contains(&key) || altered_column.contains(&key)
                })
            };
            for k in &src.checks {
                if tgt
                    .checks
                    .iter()
                    .find(|t| t.name.text == k.name.text)
                    .is_none_or(|t| expr_text(&k.expr, renamed) != expr_text(&t.expr, same) || forced_check(&t.expr))
                {
                    self.drop_objects.entry(source_name).or_default().push(ObjectRef { kind: "check", name: &k.name.text });
                }
            }
            for k in &tgt.checks {
                if src
                    .checks
                    .iter()
                    .find(|s| s.name.text == k.name.text)
                    .is_none_or(|s| expr_text(&s.expr, renamed) != expr_text(&k.expr, same) || forced_check(&k.expr))
                {
                    self.add_objects.entry(name).or_default().push(ObjectRef { kind: "check", name: &k.name.text });
                }
            }
        }
        // 지우는 table을 참조하는 남은 table의 foreign key는 target이 이미 뺐으므로
        // 위에서 지운다. 지우는 table 자신의 foreign key는 table과 함께 지운다.
        for name in self.dropped.clone() {
            for f in &self.source[name].foreign_keys {
                self.drop_objects.entry(name).or_default().push(ObjectRef { kind: "foreign_key", name: &f.name.text });
            }
        }
        for objects in self.drop_objects.values_mut().chain(self.add_objects.values_mut()) {
            objects.sort();
        }
    }

    /// 세 dialect 중 하나에서라도 렌더링한 trigger statement가 다른 table을
    /// 표시한다. source는 rename을 적용하기 전 이름 그대로 렌더링한다.
    pub(crate) fn trigger_changes(&mut self) {
        for name in self.matched.clone() {
            let (src, tgt) = (self.source[self.table_of[name]], self.target[name]);
            if [Dialect::MySql, Dialect::Postgres, Dialect::Sqlite].into_iter().any(|d| {
                let r = Renderer { d };
                r.triggers(src) != r.triggers(tgt)
            }) {
                self.triggers.insert(name);
            }
        }
    }
}

fn same(c: &str) -> &str {
    c
}

fn names(list: &[Name]) -> Vec<&str> {
    list.iter().map(|n| n.text.as_str()).collect()
}

fn names_def<'n>(list: &'n [Name], f: impl Fn(&'n str) -> &'n str) -> String {
    list.iter().map(|n| f(&n.text)).collect::<Vec<_>>().join(",")
}

fn index_def<'n>(list: &'n [(Name, bool)], f: impl Fn(&'n str) -> &'n str) -> String {
    let mut out = String::new();
    for (c, descending) in list {
        out.push_str(f(&c.text));
        if *descending {
            out.push_str(" desc");
        }
        out.push(',');
    }
    out
}

fn foreign_key_def(cols: &[&str], parent: &str, refs: &[&str], f: &ForeignKey) -> String {
    format!("{}>{parent}({}){}/{}", cols.join(","), refs.join(","), f.on_delete.as_str(), f.on_update.as_str())
}

/// column 이름을 f로 바꾼 식의 canonical text.
fn expr_text<'e>(e: &'e Expr, f: impl Fn(&'e str) -> &'e str + Copy) -> String {
    let mut out = String::new();
    emit_expr(&mut out, &renamed_expr(e, f));
    out
}

fn renamed_expr<'e>(e: &'e Expr, f: impl Fn(&'e str) -> &'e str + Copy) -> Expr {
    let name = |n: &'e Name| Name { text: f(&n.text).to_owned(), pos: n.pos };
    let operand = |o: &'e Operand| match o {
        Operand::Column(n) => Operand::Column(name(n)),
        Operand::Literal(l) => Operand::Literal(l.clone()),
    };
    match e {
        Expr::Logic(left, op, right) => Expr::Logic(Box::new(renamed_expr(left, f)), op, Box::new(renamed_expr(right, f))),
        Expr::Compare(left, op, pos, right) => Expr::Compare(operand(left), op, *pos, operand(right)),
        Expr::In(n, negated, list) => Expr::In(name(n), *negated, list.clone()),
        Expr::IsNull(n, negated) => Expr::IsNull(name(n), *negated),
    }
}
