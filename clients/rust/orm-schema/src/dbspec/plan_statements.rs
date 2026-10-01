//! The statements of a plan in one dialect (docs/plans.md, "Statements"),
//! written with the renderer of [`super::render`].

use super::model::{Column, Table, Type};
use super::plan::{sorted_by, Plan};
use super::plan_diff::{column_of, diff_plan, has_triggers, same_default, ObjectRef, PlanDiff};
use super::render::{Dialect, Renderer};
use super::{Diagnostic, Document};
use std::collections::{BTreeMap, BTreeSet};

/// Writes the statements of `plan` in `dialect`. `source` is the schema the
/// plan starts from, `None` for the empty database. The diagnostics are those
/// of [`super::diff`].
pub fn plan_statements(source: Option<&Document>, plan: &Plan, dialect: Dialect) -> Result<Vec<String>, Vec<Diagnostic>> {
    let d = diff_plan(source, plan)?;
    let mut w = PlanWriter { d: &d, r: Renderer { d: dialect }, out: Vec::new(), rebuilt: BTreeSet::new() };
    w.statements();
    Ok(w.out)
}

/// renderer CHECK 이름: 식
type RendererChecks = BTreeMap<String, String>;

struct PlanWriter<'w, 'd> {
    d: &'w PlanDiff<'d>,
    r: Renderer,
    out: Vec<String>,
    /// SQLite에서 다시 만드는 target table
    rebuilt: BTreeSet<&'d str>,
}

impl<'d> PlanWriter<'_, 'd> {
    fn add(&mut self, statement: String) {
        self.out.push(statement);
    }

    fn q(&self, name: &str) -> String {
        self.r.q(name)
    }

    fn statements(&mut self) {
        let d = self.d;
        let sqlite = self.r.d == Dialect::Sqlite;
        if sqlite {
            for &name in &d.matched {
                if self.sqlite_rebuilds(name) {
                    self.rebuilt.insert(name);
                }
            }
        }
        // 1. trigger
        for &name in &d.matched {
            let src = d.source[d.table_of[name]];
            if has_triggers(src) && (d.triggers.contains(name) || self.rebuilt.contains(name)) {
                self.drop_triggers(src);
            }
        }
        for &name in &d.dropped {
            if has_triggers(d.source[name]) {
                self.drop_triggers(d.source[name]);
            }
        }
        // 2. foreign key, 3. check, unique, index
        if !sqlite {
            for (s, objects) in &d.drop_objects {
                for o in objects.iter().filter(|o| o.kind == "foreign_key") {
                    self.drop_object(s, o);
                }
            }
        }
        for (&s, objects) in &d.drop_objects {
            if sqlite && (self.rebuilt.contains(self.target_name(s)) || d.dropped.contains(&s)) {
                continue;
            }
            for o in objects.iter().filter(|o| o.kind != "foreign_key" && !(sqlite && o.kind == "check")) {
                self.drop_object(s, o);
            }
        }
        let mut renderer_checks: BTreeMap<&str, (RendererChecks, RendererChecks)> = BTreeMap::new();
        if !sqlite {
            for &name in &d.matched {
                let src = d.source[d.table_of[name]];
                let (before, after) = (self.renderer_checks(src), self.renderer_checks(d.target[name]));
                for (n, check) in &before {
                    if after.get(n) != Some(check) {
                        let statement = self.drop_check(&src.name.text, n);
                        self.add(statement);
                    }
                }
                renderer_checks.insert(name, (before, after));
            }
        }
        // 4. rename
        for r in sorted_by(&d.renamed_tables, |r| r.old.clone()) {
            self.add(format!("ALTER TABLE {} RENAME TO {}", self.q(&r.old), self.q(&r.new)));
        }
        for r in sorted_by(&d.renamed_columns, |r| format!("{}.{}", r.table, r.old)) {
            self.add(format!("ALTER TABLE {} RENAME COLUMN {} TO {}", self.q(&r.table), self.q(&r.old), self.q(&r.new)));
        }
        // 5. drop column, drop table
        if !sqlite {
            for &name in &d.matched {
                for c in d.removed.get(name).into_iter().flatten() {
                    self.add(format!("ALTER TABLE {} DROP COLUMN {}", self.q(name), self.q(c)));
                }
            }
        }
        for name in &d.dropped {
            self.add(format!("DROP TABLE {}", self.q(name)));
        }
        // 6. create table
        for &name in &d.created {
            let statements = self.r.table(d.target[name]);
            self.out.extend(statements);
        }
        // 7. add, alter column; SQLite rebuild
        for &name in &d.matched {
            if sqlite {
                if self.rebuilt.contains(name) {
                    self.rebuild(name);
                }
                continue;
            }
            let t = d.target[name];
            for c in d.added.get(name).into_iter().flatten() {
                let column = self.r.column(column_of(t, c).expect("an added column is a target column"));
                self.add(format!("ALTER TABLE {} ADD COLUMN {column}", self.q(name)));
            }
            for &c in d.altered.get(name).into_iter().flatten() {
                let from = column_of(d.source[d.table_of[name]], d.column_of[name][c]).expect("an altered column is a source column");
                let to = column_of(t, c).expect("an altered column is a target column");
                self.alter_column(name, from, to);
            }
        }
        // 8. unique, index, check
        for (&t, objects) in &d.add_objects {
            if self.rebuilt.contains(t) {
                continue;
            }
            for o in objects.iter().filter(|o| o.kind != "foreign_key" && !(sqlite && o.kind == "check")) {
                self.add_object(t, o);
            }
        }
        if !sqlite {
            for &name in &d.matched {
                let (before, after) = &renderer_checks[name];
                for (n, check) in after {
                    if before.get(n) != Some(check) {
                        self.add(format!("ALTER TABLE {} ADD CONSTRAINT {} CHECK ({check})", self.q(name), self.q(n)));
                    }
                }
            }
        }
        // 9. foreign key
        if !sqlite {
            for &name in &d.created {
                for f in sorted_by(&d.target[name].foreign_keys, |f| f.name.text.clone()) {
                    self.add(format!("ALTER TABLE {} ADD {}", self.q(name), self.r.foreign_key(f)));
                }
            }
            for (&t, objects) in &d.add_objects {
                for o in objects.iter().filter(|o| o.kind == "foreign_key") {
                    self.add_object(t, o);
                }
            }
        }
        // 10. trigger
        for &name in &d.created {
            let statements = self.r.triggers(d.target[name]);
            self.out.extend(statements);
        }
        for &name in &d.matched {
            let t = d.target[name];
            if has_triggers(t) && (d.triggers.contains(name) || self.rebuilt.contains(name)) {
                let statements = self.r.triggers(t);
                self.out.extend(statements);
            }
        }
    }

    /// source table의 target 이름.
    fn target_name(&self, source: &'d str) -> &'d str {
        self.d.table_of.iter().find(|(_, &s)| s == source).map_or(source, |(&t, _)| t)
    }

    /// SQLite가 table을 다시 만들어야 하는지 알려 준다: 이름, column, foreign
    /// key, check 중 하나라도 바뀌면 그렇다. index와 unique만 바뀌거나 trigger만
    /// 바뀌면 다시 만들지 않는다.
    fn sqlite_rebuilds(&self, name: &str) -> bool {
        let d = self.d;
        let table_changes = |objects: Option<&Vec<ObjectRef>>| objects.into_iter().flatten().any(|o| o.kind == "foreign_key" || o.kind == "check");
        d.table_of[name] != name
            || d.added.contains_key(name)
            || d.removed.contains_key(name)
            || d.altered.contains_key(name)
            || d.renamed_columns.iter().any(|r| r.table == name)
            || table_changes(d.drop_objects.get(d.table_of[name]))
            || table_changes(d.add_objects.get(name))
    }

    /// SQLite table을 target 정의로 다시 만들고 맞는 column을 옮긴다.
    fn rebuild(&mut self, name: &str) {
        let d = self.d;
        let t = d.target[name];
        let src = d.source[d.table_of[name]];
        let statements = self.r.table(t);
        let prefix = format!("CREATE TABLE {} (", self.q(name));
        let rest = statements[0].strip_prefix(&prefix).expect("the renderer starts a table with CREATE TABLE");
        self.add(format!("CREATE TABLE {} ({rest}", self.q("$rebuild")));
        let mut into = Vec::new();
        let mut from = Vec::new();
        for c in &t.columns {
            let Some(&old) = d.column_of[name].get(c.name.text.as_str()) else { continue };
            into.push(self.q(&c.name.text));
            // rename은 이미 끝났으므로 source column은 target 이름이다.
            from.push(self.copy_value(column_of(src, old).expect("a kept column is a source column"), c));
        }
        self.add(format!("INSERT INTO {} ({}) SELECT {} FROM {}", self.q("$rebuild"), into.join(", "), from.join(", "), self.q(name)));
        self.add(format!("DROP TABLE {}", self.q(name)));
        self.add(format!("ALTER TABLE {} RENAME TO {}", self.q("$rebuild"), self.q(name)));
        self.out.extend(statements.into_iter().skip(1));
    }

    /// SQLite rebuild에서 source 값을 target column 형식으로 옮기는 식이다. time과
    /// datetime은 늘어난 소수 자리를 0으로 채운다.
    fn copy_value(&self, from: &Column, to: &Column) -> String {
        let q = self.q(&to.name.text);
        let precisions = match (from.ty, to.ty) {
            (Type::Time(p), Type::Time(q)) | (Type::DateTime(p), Type::DateTime(q)) => Some((p, q)),
            _ => None,
        };
        match precisions {
            Some((p, grown)) if grown > p => {
                let digits = "0".repeat(usize::from(grown - p));
                let pad = if p == 0 { format!(".{digits}") } else { digits };
                format!("{q} || '{pad}'")
            }
            _ => q,
        }
    }

    fn alter_column(&mut self, table: &str, from: &Column, to: &Column) {
        if self.r.d == Dialect::MySql {
            let column = self.r.column(to);
            self.add(format!("ALTER TABLE {} MODIFY COLUMN {column}", self.q(table)));
            return;
        }
        let prefix = format!("ALTER TABLE {} ALTER COLUMN {}", self.q(table), self.q(&to.name.text));
        if from.ty != to.ty {
            self.add(format!("{prefix} TYPE {}", self.r.type_text(to.ty)));
        }
        if from.nullable != to.nullable {
            self.add(format!("{prefix} {}", if to.nullable { "DROP NOT NULL" } else { "SET NOT NULL" }));
        }
        if !same_default(&from.default, &to.default) || (to.default.is_some() && from.ty != to.ty) {
            match &to.default {
                None => self.add(format!("{prefix} DROP DEFAULT")),
                Some(default) => self.add(format!("{prefix} SET DEFAULT {}", self.r.default_text(to.ty, default))),
            }
        }
    }

    fn drop_triggers(&mut self, t: &Table) {
        for statement in self.r.triggers(t) {
            let Some(rest) = statement.strip_prefix("CREATE TRIGGER ") else { continue };
            let name = &rest[..rest.find(' ').expect("a trigger statement has a name and a body")];
            match self.r.d {
                Dialect::Postgres => {
                    self.add(format!("DROP TRIGGER {name} ON {}", self.q(&t.name.text)));
                    self.add(format!("DROP FUNCTION {name}()"));
                }
                Dialect::MySql | Dialect::Sqlite => self.add(format!("DROP TRIGGER {name}")),
            }
        }
    }

    fn drop_check(&self, table: &str, name: &str) -> String {
        match self.r.d {
            Dialect::MySql => format!("ALTER TABLE {} DROP CHECK {}", self.q(table), self.q(name)),
            Dialect::Postgres | Dialect::Sqlite => format!("ALTER TABLE {} DROP CONSTRAINT {}", self.q(table), self.q(name)),
        }
    }

    fn drop_object(&mut self, table: &str, o: &ObjectRef) {
        let statement = match (o.kind, self.r.d) {
            ("check", _) => self.drop_check(table, o.name),
            ("foreign_key", Dialect::MySql) => format!("ALTER TABLE {} DROP FOREIGN KEY {}", self.q(table), self.q(o.name)),
            ("unique", Dialect::MySql) => format!("ALTER TABLE {} DROP INDEX {}", self.q(table), self.q(o.name)),
            ("index", Dialect::MySql) => format!("DROP INDEX {} ON {}", self.q(o.name), self.q(table)),
            ("foreign_key" | "unique", Dialect::Postgres) => format!("ALTER TABLE {} DROP CONSTRAINT {}", self.q(table), self.q(o.name)),
            _ => format!("DROP INDEX {}", self.q(o.name)),
        };
        self.add(statement);
    }

    fn add_object(&mut self, table: &str, o: &ObjectRef) {
        let t = self.d.target[table];
        let statement = match o.kind {
            "unique" => {
                let u = t.uniques.iter().find(|u| u.name.text == o.name).expect("an added unique key is a target key");
                let columns = self.r.list(u.columns.iter().map(|n| &n.text));
                if self.r.d == Dialect::Sqlite {
                    format!("CREATE UNIQUE INDEX {} ON {} ({columns})", self.q(&u.name.text), self.q(table))
                } else {
                    format!("ALTER TABLE {} ADD CONSTRAINT {} UNIQUE ({columns})", self.q(table), self.q(&u.name.text))
                }
            }
            "index" => {
                let x = t.indexes.iter().find(|x| x.name.text == o.name).expect("an added index is a target index");
                let columns: Vec<String> =
                    x.columns.iter().map(|(c, descending)| if *descending { format!("{} DESC", self.q(&c.text)) } else { self.q(&c.text) }).collect();
                format!("CREATE INDEX {} ON {} ({})", self.q(&x.name.text), self.q(table), columns.join(", "))
            }
            "check" => {
                let k = t.checks.iter().find(|k| k.name.text == o.name).expect("an added check is a target check");
                let mut b = String::new();
                self.r.predicate(&mut b, t, &k.expr);
                format!("ALTER TABLE {} ADD CONSTRAINT {} CHECK ({b})", self.q(table), self.q(&k.name.text))
            }
            _ => {
                let f = t.foreign_keys.iter().find(|f| f.name.text == o.name).expect("an added foreign key is a target key");
                format!("ALTER TABLE {} ADD {}", self.q(table), self.r.foreign_key(f))
            }
        };
        self.add(statement);
    }

    /// table의 renderer CHECK 이름과 식.
    fn renderer_checks(&self, t: &Table) -> RendererChecks {
        t.columns.iter().filter_map(|c| self.r.type_check(c).map(|check| (format!("{}${}", t.name.text, c.name.text), check))).collect()
    }
}
