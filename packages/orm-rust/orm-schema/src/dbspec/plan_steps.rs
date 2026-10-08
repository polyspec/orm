//! The steps of a plan in one dialect, each with its rollback statement and
//! effect (docs/plans.md, "Steps"), written with the renderer of
//! [`super::render`].

use super::model::{Column, Expr, Name, Operand, Table, Type};
use super::plan::{sorted_by, Plan};
use super::plan_diff::{column_of, diff_plan, has_triggers, same_default, ObjectRef, PlanDiff};
use super::render::{Dialect, Renderer};
use super::{Diagnostic, Document};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

/// How a step's statement shows that it took effect (docs/plans.md,
/// "Effects"). `kind` is table, column, index, constraint, trigger, function,
/// sequence, rows or repeat; `present` is the state after the statement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Effect {
    pub kind: &'static str,
    pub table: String,
    pub name: String,
    pub present: bool,
}

impl fmt::Display for Effect {
    /// The text form of docs/plans.md "Effects", such as `present table users`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.kind == "repeat" {
            return f.write_str("repeat");
        }
        write!(f, "{} {}", if self.present { "present" } else { "absent" }, self.kind)?;
        for n in [&self.table, &self.name] {
            if !n.is_empty() {
                write!(f, " {n}")?;
            }
        }
        Ok(())
    }
}

/// A column that a rollback statement makes non-null again: its table, its
/// name in the applied plan and the SQL text of its source default.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NullCheck {
    pub table: String,
    pub column: String,
    pub default: Option<String>,
}

/// One step of a plan (docs/plans.md, "Steps"): its statement, its rollback
/// statement or, without one, the reason in `irreversible` (empty for a
/// finalize step), its effect, the restore statements that replace the
/// statement and the rollback statement when `restore_if` holds, the null
/// checks of its rollback and whether it is a finalize step.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanStep {
    pub statement: String,
    pub rollback: String,
    pub irreversible: String,
    pub effect: Effect,
    pub restore: String,
    pub rollback_restore: String,
    pub restore_if: Option<Effect>,
    pub null_checks: Vec<NullCheck>,
    pub finalize: bool,
}

/// 되돌릴 수 없는 step의 이유(docs/plans.md "Irreversible steps").
const IRREVERSIBLE_PRECISION: &str = "narrowing the precision rounds the values written since";
/// SQLite 다시 만들기의 작업 table.
const REBUILD_TABLE: &str = "dbspec$rebuild";

/// Writes the steps of `plan` in `dialect`. `source` is the schema the plan
/// starts from, `None` for the empty database. The diagnostics are those of
/// [`super::diff`].
pub fn plan_steps(source: Option<&Document>, plan: &Plan, dialect: Dialect) -> Result<Vec<PlanStep>, Vec<Diagnostic>> {
    let d = diff_plan(source, plan)?;
    let hash = plan.to.strip_prefix("sha256:").unwrap_or(&plan.to);
    let mut w = PlanWriter {
        d: &d,
        r: Renderer { d: dialect },
        out: Vec::new(),
        rebuilt: BTreeSet::new(),
        hold_prefix: format!("dbspec$hold${}$", &hash[..12]),
        holds: BTreeMap::new(),
        hold_order: Vec::new(),
    };
    w.steps();
    Ok(w.out)
}

fn present(kind: &'static str, table: &str, name: &str) -> Effect {
    Effect { kind, table: table.to_owned(), name: name.to_owned(), present: true }
}

fn absent(kind: &'static str, table: &str, name: &str) -> Effect {
    Effect { kind, table: table.to_owned(), name: name.to_owned(), present: false }
}

fn repeat() -> Effect {
    Effect { kind: "repeat", table: String::new(), name: String::new(), present: true }
}

/// optional 부분이 빈 step.
fn step(statement: String, rollback: String, effect: Effect) -> PlanStep {
    PlanStep {
        statement,
        rollback,
        irreversible: String::new(),
        effect,
        restore: String::new(),
        rollback_restore: String::new(),
        restore_if: None,
        null_checks: Vec::new(),
        finalize: false,
    }
}

/// time이나 datetime의 정밀도가 커지는지 알려 준다.
fn precision_grows(from: Type, to: Type) -> Option<(u8, u8)> {
    match (from, to) {
        (Type::Time(p), Type::Time(q)) | (Type::DateTime(p), Type::DateTime(q)) if q > p => Some((p, q)),
        _ => None,
    }
}

/// column 이름을 f로 바꾼 식.
fn rename_expr(e: &Expr, f: &dyn Fn(&str) -> String) -> Expr {
    let name = |n: &Name| Name { text: f(&n.text), pos: n.pos };
    let operand = |o: &Operand| match o {
        Operand::Column(n) => Operand::Column(name(n)),
        Operand::Literal(l) => Operand::Literal(l.clone()),
    };
    match e {
        Expr::Logic(left, op, right) => Expr::Logic(Box::new(rename_expr(left, f)), op, Box::new(rename_expr(right, f))),
        Expr::Compare(left, op, pos, right) => Expr::Compare(operand(left), op, *pos, operand(right)),
        Expr::In(n, negated, list) => Expr::In(name(n), *negated, list.clone()),
        Expr::IsNull(n, negated) => Expr::IsNull(name(n), *negated),
    }
}

/// renderer CHECK 이름: 식
type RendererChecks = BTreeMap<String, String>;

/// table의 unique key나 index 하나를 만들고 지우는 statement.
struct NamedIndex {
    name: String,
    create: String,
    drop: String,
}

/// trigger 하나와 그 CREATE TRIGGER, PostgreSQL function.
struct TriggerPart {
    name: String,
    create: String,
    function: String,
}

struct PlanWriter<'w, 'd> {
    d: &'w PlanDiff<'d>,
    r: Renderer,
    out: Vec<PlanStep>,
    /// SQLite에서 다시 만드는 target table
    rebuilt: BTreeSet<&'d str>,
    hold_prefix: String,
    /// 보관 이름: "table.column"(지우는 column, source 이름), table(지우는 table),
    /// "+table.column"(더하는 column, target 이름)
    holds: BTreeMap<String, String>,
    hold_order: Vec<String>,
}

impl<'d> PlanWriter<'_, 'd> {
    fn add(&mut self, s: PlanStep) {
        self.out.push(s);
    }

    fn q(&self, name: &str) -> String {
        self.r.q(name)
    }

    fn hold(&self, key: &str) -> String {
        self.holds.get(key).cloned().expect("every dropped and added name has a holding name")
    }

    /// docs/plans.md "Hiding instead of dropping"의 순서로 보관 이름을 정한다.
    fn number_holds(&mut self) {
        let d = self.d;
        let mut keys = Vec::new();
        for &name in &d.matched {
            for c in d.removed.get(name).into_iter().flatten() {
                keys.push(format!("{}.{c}", d.table_of[name]));
            }
        }
        for name in &d.dropped {
            keys.push((*name).to_owned());
        }
        for &name in &d.matched {
            for c in d.added.get(name).into_iter().flatten() {
                keys.push(format!("+{name}.{c}"));
            }
        }
        for (i, key) in keys.into_iter().enumerate() {
            self.holds.insert(key.clone(), format!("{}{}", self.hold_prefix, i + 1));
            self.hold_order.push(key);
        }
    }

    fn steps(&mut self) {
        let d = self.d;
        let sqlite = self.r.d == Dialect::Sqlite;
        self.number_holds();
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
        // 2. foreign key
        if !sqlite {
            for (s, objects) in &d.drop_objects {
                for o in objects.iter().filter(|o| o.kind == "foreign_key") {
                    self.drop_object(d.source[s], o.kind, o.name);
                }
            }
        }
        // 3. check, unique, index와 지우는 table의 객체
        let mut drop_tables: BTreeMap<&str, Vec<ObjectRef<'d>>> = BTreeMap::new();
        for (&s, objects) in &d.drop_objects {
            if sqlite && (self.rebuilt.contains(self.target_name(s)) || d.dropped.contains(&s)) {
                continue;
            }
            for &o in objects.iter().filter(|o| o.kind != "foreign_key" && !(sqlite && o.kind == "check")) {
                drop_tables.entry(s).or_default().push(o);
            }
        }
        for &s in &d.dropped {
            let t = d.source[s];
            let list = drop_tables.entry(s).or_default();
            for u in &t.uniques {
                list.push(ObjectRef { kind: "unique", name: &u.name.text });
            }
            for x in &t.indexes {
                list.push(ObjectRef { kind: "index", name: &x.name.text });
            }
            if !sqlite {
                for k in &t.checks {
                    list.push(ObjectRef { kind: "check", name: &k.name.text });
                }
            }
        }
        for (s, mut objects) in drop_tables {
            objects.sort_by(|a, b| format!("{}\0{}", a.kind, a.name).cmp(&format!("{}\0{}", b.kind, b.name)));
            for o in objects {
                self.drop_object(d.source[s], o.kind, o.name);
            }
        }
        let mut renderer_checks: BTreeMap<&str, (RendererChecks, RendererChecks)> = BTreeMap::new();
        if !sqlite {
            for &name in &d.matched {
                let src = d.source[d.table_of[name]];
                let (before, after) = (self.renderer_checks(src), self.renderer_checks(d.target[name]));
                for (n, check) in &before {
                    if after.get(n) != Some(check) {
                        self.drop_renderer_check(&src.name.text, n, check);
                    }
                }
                renderer_checks.insert(name, (before, after));
            }
            for &s in &d.dropped {
                for (n, check) in &self.renderer_checks(d.source[s]) {
                    self.drop_renderer_check(s, n, check);
                }
            }
        }
        // 4. rename
        for r in sorted_by(&d.renamed_tables, |r| r.old.clone()) {
            self.add(step(
                format!("ALTER TABLE {} RENAME TO {}", self.q(&r.old), self.q(&r.new)),
                format!("ALTER TABLE {} RENAME TO {}", self.q(&r.new), self.q(&r.old)),
                present("table", &r.new, ""),
            ));
        }
        for r in sorted_by(&d.renamed_columns, |r| format!("{}.{}", r.table, r.old)) {
            self.add(step(self.rename_column(&r.table, &r.old, &r.new), self.rename_column(&r.table, &r.new, &r.old), present("column", &r.table, &r.new)));
        }
        // 5. 지우는 column과 table을 숨긴다
        if !sqlite {
            for &name in &d.matched {
                let src = d.source[d.table_of[name]];
                for &c in d.removed.get(name).into_iter().flatten() {
                    let column = column_of(src, c).expect("a dropped column is a source column");
                    let h = self.hold(&format!("{}.{c}", src.name.text));
                    self.hide_column(name, column, &h);
                }
            }
        }
        for &name in &d.dropped {
            let h = self.hold(name);
            self.add(step(
                format!("ALTER TABLE {} RENAME TO {}", self.q(name), self.q(&h)),
                format!("ALTER TABLE {} RENAME TO {}", self.q(&h), self.q(name)),
                present("table", &h, ""),
            ));
        }
        // 6. create table
        for &name in &d.created {
            let t = d.target[name];
            let create = self.r.table(t).swap_remove(0);
            self.add(step(create, format!("DROP TABLE {}", self.q(name)), present("table", name, "")));
            self.create_indexes(t, name);
        }
        // 7. add, alter column; SQLite 다시 만들기
        for &name in &d.matched {
            if sqlite {
                if self.rebuilt.contains(name) {
                    self.rebuild(name);
                }
                continue;
            }
            let t = d.target[name];
            for &c in d.added.get(name).into_iter().flatten() {
                let h = self.hold(&format!("+{name}.{c}"));
                let column = self.r.column(column_of(t, c).expect("an added column is a target column"));
                let mut s = step(format!("ALTER TABLE {} ADD COLUMN {column}", self.q(name)), self.rename_column(name, c, &h), present("column", name, c));
                s.restore = self.rename_column(name, &h, c);
                s.restore_if = Some(present("column", name, &h));
                self.add(s);
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
                self.add_object(t, o.kind, o.name);
            }
        }
        if !sqlite {
            for &name in &d.matched {
                let (before, after) = &renderer_checks[name];
                for (n, check) in after {
                    if before.get(n) != Some(check) {
                        self.add(step(
                            format!("ALTER TABLE {} ADD CONSTRAINT {} CHECK ({check})", self.q(name), self.q(n)),
                            self.drop_check(name, n),
                            present("constraint", name, n),
                        ));
                    }
                }
            }
        }
        // 9. foreign key
        if !sqlite {
            for &name in &d.created {
                for f in sorted_by(&d.target[name].foreign_keys, |f| f.name.text.clone()) {
                    self.add_object(name, "foreign_key", &f.name.text);
                }
            }
            for (&t, objects) in &d.add_objects {
                for o in objects.iter().filter(|o| o.kind == "foreign_key") {
                    self.add_object(t, o.kind, o.name);
                }
            }
        }
        // 10. trigger
        for &name in &d.created {
            self.create_triggers(d.target[name]);
        }
        for &name in &d.matched {
            let t = d.target[name];
            if has_triggers(t) && (d.triggers.contains(name) || self.rebuilt.contains(name)) {
                self.create_triggers(t);
            }
        }
        // 11. finalize
        for key in self.hold_order.clone() {
            let h = self.holds[&key].clone();
            if key.starts_with('+') {
                continue;
            }
            let mut s = if let Some((source, _)) = key.split_once('.') {
                let table = self.target_name(source).to_owned();
                step(format!("ALTER TABLE {} DROP COLUMN {}", self.q(&table), self.q(&h)), String::new(), absent("column", &table, &h))
            } else {
                step(format!("DROP TABLE {}", self.q(&h)), String::new(), absent("table", &h, ""))
            };
            s.finalize = true;
            self.add(s);
        }
    }

    /// source table의 target 이름.
    fn target_name<'s>(&self, source: &'s str) -> &'s str
    where
        'd: 's,
    {
        self.d.table_of.iter().find(|(_, &s)| s == source).map_or(source, |(&t, _)| t)
    }

    fn rename_column(&self, table: &str, from: &str, to: &str) -> String {
        format!("ALTER TABLE {} RENAME COLUMN {} TO {}", self.q(table), self.q(from), self.q(to))
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

    /// MySQL과 PostgreSQL에서 지우는 column을 nullable로 바꾸고 보관 이름으로 숨긴다.
    fn hide_column(&mut self, table: &str, c: &Column, h: &str) {
        if !c.nullable {
            let mut nullable = c.clone();
            nullable.nullable = true;
            let checks = vec![self.null_check(table, h, c)];
            let mut s = if self.r.d == Dialect::MySql {
                step(
                    format!("ALTER TABLE {} MODIFY COLUMN {}", self.q(table), self.r.column(&nullable)),
                    format!("ALTER TABLE {} MODIFY COLUMN {}", self.q(table), self.r.column(c)),
                    repeat(),
                )
            } else {
                let prefix = format!("ALTER TABLE {} ALTER COLUMN {}", self.q(table), self.q(&c.name.text));
                step(format!("{prefix} DROP NOT NULL"), format!("{prefix} SET NOT NULL"), repeat())
            };
            s.null_checks = checks;
            self.add(s);
        }
        self.add(step(self.rename_column(table, &c.name.text, h), self.rename_column(table, h, &c.name.text), present("column", table, h)));
    }

    /// source column c를 non-null로 되돌리는 rollback의 null 검사다.
    fn null_check(&self, table: &str, column: &str, c: &Column) -> NullCheck {
        NullCheck { table: table.to_owned(), column: column.to_owned(), default: c.default.as_ref().map(|d| self.r.default_text(c.ty, d)) }
    }

    /// SQLite table을 작업 table을 거쳐 다시 만든다(docs/plans.md "Steps").
    fn rebuild(&mut self, name: &str) {
        let d = self.d;
        let t = d.target[name];
        let src = d.source[d.table_of[name]];
        let work = self.q(REBUILD_TABLE);
        let qn = self.q(name);
        let removed: Vec<&str> = d.removed.get(name).cloned().unwrap_or_default();
        let added: Vec<&str> = d.added.get(name).cloned().unwrap_or_default();
        let columns = &d.column_of[name];
        // 새 정의: target table과 보관 이름의 지우는 column
        let hidden_dropped: Vec<Column> = removed
            .iter()
            .map(|c| {
                let mut column = column_of(src, c).expect("a dropped column is a source column").clone();
                column.name.text = self.hold(&format!("{}.{c}", src.name.text));
                column
            })
            .collect();
        // 옛 정의: 이름 바꾸기를 적용한 source table과 보관 이름의 더하는 column
        let old = self.renamed_source(name);
        let hidden_added: Vec<Column> = added
            .iter()
            .map(|c| {
                let mut column = column_of(t, c).expect("an added column is a target column").clone();
                column.name.text = self.hold(&format!("+{name}.{c}"));
                column
            })
            .collect();
        let new_create = |as_name: &str| self.r.create_table(t, as_name, &|c: &str| format!("{}${c}", t.name.text), &hidden_dropped);
        // source_column은 옛 정의 column의 source 이름이다. 지우는 column은 이름이 그대로다.
        let source_column = |c: &str| -> String { columns.get(c).map_or_else(|| c.to_owned(), |s| (*s).to_owned()) };
        let old_create = self.r.create_table(&old, name, &|c: &str| format!("{}${}", src.name.text, source_column(c)), &hidden_added);
        let new_names: Vec<String> = t.columns.iter().map(|c| c.name.text.clone()).chain(hidden_dropped.iter().map(|c| c.name.text.clone())).collect();
        let new_list = self.r.list(new_names.iter());
        // 옛 table에서 새 정의로 옮기는 식
        let (mut into, mut from, mut into_restore, mut from_restore) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for c in &t.columns {
            if let Some(&old_name) = columns.get(c.name.text.as_str()) {
                let e = self.copy_value(column_of(src, old_name).expect("a kept column is a source column"), c);
                into.push(self.q(&c.name.text));
                from.push(e.clone());
                into_restore.push(self.q(&c.name.text));
                from_restore.push(e);
            } else {
                into_restore.push(self.q(&c.name.text));
                from_restore.push(self.q(&self.hold(&format!("+{name}.{}", c.name.text))));
            }
        }
        for (i, c) in removed.iter().enumerate() {
            into.push(self.q(&hidden_dropped[i].name.text));
            from.push(self.q(c));
            into_restore.push(self.q(&hidden_dropped[i].name.text));
            from_restore.push(self.q(c));
        }
        // 새 정의에서 옛 정의로 되돌리는 식
        let (mut back_into, mut back_from) = (Vec::new(), Vec::new());
        let mut irreversible = "";
        let mut checks = Vec::new();
        for c in &old.columns {
            back_into.push(self.q(&c.name.text));
            let source_name = source_column(&c.name.text);
            if let Some(tc) = column_of(t, &c.name.text).filter(|_| !removed.contains(&source_name.as_str())) {
                back_from.push(self.q(&c.name.text));
                if precision_grows(c.ty, tc.ty).is_some() {
                    irreversible = IRREVERSIBLE_PRECISION;
                }
                if !c.nullable && tc.nullable {
                    checks.push(self.null_check(name, &c.name.text, c));
                }
                continue;
            }
            // 지우는 column: 새 정의에서는 보관 이름이다.
            let h = self.hold(&format!("{}.{source_name}", src.name.text));
            back_from.push(self.q(&h));
            if !c.nullable {
                checks.push(self.null_check(name, &h, c));
            }
        }
        // 옛 table에 숨긴 더한 column이 있으면 그 값도 되돌린다.
        let mut back_into_restore = back_into.clone();
        let mut back_from_restore = back_from.clone();
        for (i, c) in added.iter().enumerate() {
            back_into_restore.push(self.q(&hidden_added[i].name.text));
            back_from_restore.push(self.q(c));
        }
        let identity = t.columns.iter().any(|c| c.identity.is_some());
        let sequence = |to: &str, from: &str| format!("INSERT INTO sqlite_sequence (name, seq) SELECT '{to}', seq FROM sqlite_sequence WHERE name = '{from}'");
        let unsequence = |n: &str| format!("DELETE FROM sqlite_sequence WHERE name = '{n}'");
        let restore_if = hidden_added.first().map(|c| present("column", name, &c.name.text));

        let mut steps = vec![step(new_create(REBUILD_TABLE), format!("DROP TABLE {work}"), present("table", REBUILD_TABLE, ""))];
        if identity {
            steps.push(step(sequence(REBUILD_TABLE, name), unsequence(REBUILD_TABLE), present("sequence", REBUILD_TABLE, "")));
        }
        let mut copy_in = step(
            format!("INSERT INTO {work} ({}) SELECT {} FROM {qn}", into.join(", "), from.join(", ")),
            format!("DELETE FROM {work}"),
            present("rows", REBUILD_TABLE, ""),
        );
        if restore_if.is_some() {
            copy_in.restore = format!("INSERT INTO {work} ({}) SELECT {} FROM {qn}", into_restore.join(", "), from_restore.join(", "));
            copy_in.restore_if = restore_if.clone();
        }
        steps.push(copy_in);
        for x in self.indexes(&old, name) {
            steps.push(step(x.drop, x.create, absent("index", name, &x.name)));
        }
        let mut empty = step(format!("DELETE FROM {qn}"), String::new(), absent("rows", name, ""));
        empty.null_checks = checks;
        if irreversible.is_empty() {
            empty.rollback = format!("INSERT INTO {qn} ({}) SELECT {} FROM {work}", back_into.join(", "), back_from.join(", "));
            if restore_if.is_some() {
                empty.rollback_restore = format!("INSERT INTO {qn} ({}) SELECT {} FROM {work}", back_into_restore.join(", "), back_from_restore.join(", "));
                empty.restore_if = restore_if.clone();
            }
        } else {
            irreversible.clone_into(&mut empty.irreversible);
        }
        steps.push(empty);
        if identity {
            steps.push(step(unsequence(name), sequence(name, REBUILD_TABLE), absent("sequence", name, "")));
        }
        steps.push(step(format!("DROP TABLE {qn}"), old_create, absent("table", name, "")));
        steps.push(step(new_create(name), format!("DROP TABLE {qn}"), present("table", name, "")));
        if identity {
            steps.push(step(sequence(name, REBUILD_TABLE), unsequence(name), present("sequence", name, "")));
        }
        steps.push(step(format!("INSERT INTO {qn} ({new_list}) SELECT {new_list} FROM {work}"), format!("DELETE FROM {qn}"), present("rows", name, "")));
        steps.push(step(
            format!("DELETE FROM {work}"),
            format!("INSERT INTO {work} ({new_list}) SELECT {new_list} FROM {qn}"),
            absent("rows", REBUILD_TABLE, ""),
        ));
        if identity {
            steps.push(step(unsequence(REBUILD_TABLE), sequence(REBUILD_TABLE, name), absent("sequence", REBUILD_TABLE, "")));
        }
        steps.push(step(format!("DROP TABLE {work}"), new_create(REBUILD_TABLE), absent("table", REBUILD_TABLE, "")));
        self.out.extend(steps);
        self.create_indexes(t, name);
    }

    /// target table name의 source table에 이름 바꾸기를 적용한 정의다. 지우는 table을
    /// 참조하는 foreign key는 source 이름을 유지한다.
    fn renamed_source(&self, name: &str) -> Table {
        let d = self.d;
        let src = d.source[d.table_of[name]];
        let target_of_table: BTreeMap<&str, &str> = d.table_of.iter().map(|(&t, &s)| (s, t)).collect();
        let column = |table: &str, c: &str| -> String {
            d.column_of.get(table).and_then(|m| m.iter().find(|(_, &s)| s == c).map(|(&t, _)| t.to_owned())).unwrap_or_else(|| c.to_owned())
        };
        let rename = |n: &Name| Name { text: column(name, &n.text), pos: n.pos };
        let mut t = src.clone();
        t.name.text = name.to_owned();
        for c in &mut t.columns {
            c.name.text = column(name, &c.name.text);
        }
        for k in &mut t.primary {
            k.columns = k.columns.iter().map(rename).collect();
        }
        for u in &mut t.uniques {
            u.columns = u.columns.iter().map(rename).collect();
        }
        for x in &mut t.indexes {
            x.columns = x.columns.iter().map(|(n, desc)| (rename(n), *desc)).collect();
        }
        for f in &mut t.foreign_keys {
            let parent = target_of_table.get(f.table.text.as_str()).map_or_else(|| f.table.text.clone(), |p| (*p).to_owned());
            f.columns = f.columns.iter().map(rename).collect();
            f.references = f.references.iter().map(|n| Name { text: column(&parent, &n.text), pos: n.pos }).collect();
            f.table.text = parent;
        }
        for k in &mut t.checks {
            k.expr = rename_expr(&k.expr, &|c: &str| column(name, c));
        }
        t
    }

    /// SQLite 다시 만들기에서 source 값을 target column 형식으로 옮기는 식이다. time과
    /// datetime은 늘어난 소수 자리를 0으로 채운다.
    fn copy_value(&self, from: &Column, to: &Column) -> String {
        let q = self.q(&to.name.text);
        match precision_grows(from.ty, to.ty) {
            Some((p, grown)) => {
                let digits = "0".repeat(usize::from(grown - p));
                let pad = if p == 0 { format!(".{digits}") } else { digits };
                format!("{q} || '{pad}'")
            }
            None => q,
        }
    }

    fn alter_column(&mut self, table: &str, from: &Column, to: &Column) {
        let irreversible = if precision_grows(from.ty, to.ty).is_some() { IRREVERSIBLE_PRECISION } else { "" };
        let mut source = from.clone();
        source.name.text.clone_from(&to.name.text);
        let checks = if !from.nullable && to.nullable { vec![self.null_check(table, &to.name.text, &source)] } else { Vec::new() };
        if self.r.d == Dialect::MySql {
            let rollback =
                if irreversible.is_empty() { format!("ALTER TABLE {} MODIFY COLUMN {}", self.q(table), self.r.column(&source)) } else { String::new() };
            let mut s = step(format!("ALTER TABLE {} MODIFY COLUMN {}", self.q(table), self.r.column(to)), rollback, repeat());
            irreversible.clone_into(&mut s.irreversible);
            s.null_checks = checks;
            self.add(s);
            return;
        }
        let prefix = format!("ALTER TABLE {} ALTER COLUMN {}", self.q(table), self.q(&to.name.text));
        if from.ty != to.ty {
            let rollback = if irreversible.is_empty() { format!("{prefix} TYPE {}", self.r.type_text(from.ty)) } else { String::new() };
            let mut s = step(format!("{prefix} TYPE {}", self.r.type_text(to.ty)), rollback, repeat());
            irreversible.clone_into(&mut s.irreversible);
            self.add(s);
        }
        if from.nullable != to.nullable {
            if to.nullable {
                let mut s = step(format!("{prefix} DROP NOT NULL"), format!("{prefix} SET NOT NULL"), repeat());
                s.null_checks = checks;
                self.add(s);
            } else {
                self.add(step(format!("{prefix} SET NOT NULL"), format!("{prefix} DROP NOT NULL"), repeat()));
            }
        }
        if !same_default(&from.default, &to.default) || (to.default.is_some() && from.ty != to.ty) {
            let back =
                from.default.as_ref().map_or_else(|| format!("{prefix} DROP DEFAULT"), |v| format!("{prefix} SET DEFAULT {}", self.r.default_text(from.ty, v)));
            let forward =
                to.default.as_ref().map_or_else(|| format!("{prefix} DROP DEFAULT"), |v| format!("{prefix} SET DEFAULT {}", self.r.default_text(to.ty, v)));
            self.add(step(forward, back, repeat()));
        }
    }

    /// 렌더링한 trigger statement에서 trigger와 PostgreSQL function을 짝짓는다.
    fn trigger_parts(&self, t: &Table) -> Vec<TriggerPart> {
        let mut out = Vec::new();
        let mut function = String::new();
        for statement in self.r.triggers(t) {
            if statement.starts_with("CREATE FUNCTION ") {
                function = statement;
                continue;
            }
            let rest = statement.strip_prefix("CREATE TRIGGER ").expect("a rendered trigger statement creates a function or a trigger");
            let quoted = &rest[..rest.find(' ').expect("a trigger statement has a name and a body")];
            let name = quoted[1..quoted.len() - 1].to_owned();
            out.push(TriggerPart { name, create: statement.clone(), function: std::mem::take(&mut function) });
        }
        out
    }

    fn drop_triggers(&mut self, t: &Table) {
        for p in self.trigger_parts(t) {
            let table = &t.name.text;
            if self.r.d == Dialect::Postgres {
                self.add(step(format!("DROP TRIGGER {} ON {}", self.q(&p.name), self.q(table)), p.create, absent("trigger", table, &p.name)));
                self.add(step(format!("DROP FUNCTION {}()", self.q(&p.name)), p.function, absent("function", "", &p.name)));
                continue;
            }
            self.add(step(format!("DROP TRIGGER {}", self.q(&p.name)), p.create, absent("trigger", table, &p.name)));
        }
    }

    fn create_triggers(&mut self, t: &Table) {
        for p in self.trigger_parts(t) {
            let table = &t.name.text;
            if self.r.d == Dialect::Postgres {
                self.add(step(p.function, format!("DROP FUNCTION {}()", self.q(&p.name)), present("function", "", &p.name)));
                self.add(step(p.create, format!("DROP TRIGGER {} ON {}", self.q(&p.name), self.q(table)), present("trigger", table, &p.name)));
                continue;
            }
            self.add(step(p.create, format!("DROP TRIGGER {}", self.q(&p.name)), present("trigger", table, &p.name)));
        }
    }

    fn drop_check(&self, table: &str, name: &str) -> String {
        match self.r.d {
            Dialect::MySql => format!("ALTER TABLE {} DROP CHECK {}", self.q(table), self.q(name)),
            Dialect::Postgres | Dialect::Sqlite => format!("ALTER TABLE {} DROP CONSTRAINT {}", self.q(table), self.q(name)),
        }
    }

    fn drop_renderer_check(&mut self, table: &str, name: &str, expression: &str) {
        self.add(step(
            self.drop_check(table, name),
            format!("ALTER TABLE {} ADD CONSTRAINT {} CHECK ({expression})", self.q(table), self.q(name)),
            absent("constraint", table, name),
        ));
    }

    fn drop_index(&self, table: &str, name: &str) -> String {
        match self.r.d {
            Dialect::MySql => format!("DROP INDEX {} ON {}", self.q(name), self.q(table)),
            Dialect::Postgres | Dialect::Sqlite => format!("DROP INDEX {}", self.q(name)),
        }
    }

    fn create_index(&self, x: &super::model::Index, table: &str) -> String {
        let columns: Vec<String> =
            x.columns.iter().map(|(c, descending)| if *descending { format!("{} DESC", self.q(&c.text)) } else { self.q(&c.text) }).collect();
        format!("CREATE INDEX {} ON {} ({})", self.q(&x.name.text), self.q(table), columns.join(", "))
    }

    /// table t를 name으로 둔 unique key와 index를 renderer 순서로 돌려준다. SQLite
    /// unique key는 unique index다.
    fn indexes(&self, t: &Table, name: &str) -> Vec<NamedIndex> {
        let mut out = Vec::new();
        if self.r.d == Dialect::Sqlite {
            for u in sorted_by(&t.uniques, |u| u.name.text.clone()) {
                out.push(NamedIndex {
                    name: u.name.text.clone(),
                    create: format!("CREATE UNIQUE INDEX {} ON {} ({})", self.q(&u.name.text), self.q(name), self.r.list(u.columns.iter().map(|n| &n.text))),
                    drop: self.drop_index(name, &u.name.text),
                });
            }
        }
        for x in sorted_by(&t.indexes, |x| x.name.text.clone()) {
            out.push(NamedIndex { name: x.name.text.clone(), create: self.create_index(x, name), drop: self.drop_index(name, &x.name.text) });
        }
        out
    }

    /// renderer가 CREATE TABLE 뒤에 쓰는 unique index와 index다.
    fn create_indexes(&mut self, t: &Table, name: &str) {
        for x in self.indexes(t, name) {
            self.add(step(x.create, x.drop, present("index", name, &x.name)));
        }
    }

    /// table t(name으로 둔)의 객체를 더하는 statement, 지우는 statement, 그 효과의 종류다.
    fn object_statements(&self, t: &Table, name: &str, kind: &str, object: &str) -> (String, String, &'static str) {
        match kind {
            "unique" => {
                let u = t.uniques.iter().find(|u| u.name.text == object).expect("a unique key of the table");
                let columns = self.r.list(u.columns.iter().map(|n| &n.text));
                match self.r.d {
                    Dialect::Sqlite => {
                        (format!("CREATE UNIQUE INDEX {} ON {} ({columns})", self.q(object), self.q(name)), self.drop_index(name, object), "index")
                    }
                    Dialect::MySql => (
                        format!("ALTER TABLE {} ADD CONSTRAINT {} UNIQUE ({columns})", self.q(name), self.q(object)),
                        format!("ALTER TABLE {} DROP INDEX {}", self.q(name), self.q(object)),
                        "index",
                    ),
                    Dialect::Postgres => (
                        format!("ALTER TABLE {} ADD CONSTRAINT {} UNIQUE ({columns})", self.q(name), self.q(object)),
                        format!("ALTER TABLE {} DROP CONSTRAINT {}", self.q(name), self.q(object)),
                        "constraint",
                    ),
                }
            }
            "index" => {
                let x = t.indexes.iter().find(|x| x.name.text == object).expect("an index of the table");
                (self.create_index(x, name), self.drop_index(name, object), "index")
            }
            "check" => {
                let k = t.checks.iter().find(|k| k.name.text == object).expect("a check of the table");
                let mut b = String::new();
                self.r.predicate(&mut b, t, &k.expr);
                (format!("ALTER TABLE {} ADD CONSTRAINT {} CHECK ({b})", self.q(name), self.q(object)), self.drop_check(name, object), "constraint")
            }
            _ => {
                let f = t.foreign_keys.iter().find(|f| f.name.text == object).expect("a foreign key of the table");
                let drop = match self.r.d {
                    Dialect::MySql => format!("ALTER TABLE {} DROP FOREIGN KEY {}", self.q(name), self.q(object)),
                    Dialect::Postgres | Dialect::Sqlite => format!("ALTER TABLE {} DROP CONSTRAINT {}", self.q(name), self.q(object)),
                };
                (format!("ALTER TABLE {} ADD {}", self.q(name), self.r.foreign_key(f)), drop, "constraint")
            }
        }
    }

    /// source table t의 객체를 지우고, rollback은 source 정의로 다시 만든다.
    fn drop_object(&mut self, t: &Table, kind: &str, object: &str) {
        let (create, drop, effect) = self.object_statements(t, &t.name.text, kind, object);
        self.add(step(drop, create, absent(effect, &t.name.text, object)));
    }

    fn add_object(&mut self, table: &str, kind: &str, object: &str) {
        let (create, drop, effect) = self.object_statements(self.d.target[table], table, kind, object);
        self.add(step(create, drop, present(effect, table, object)));
    }

    /// table의 renderer CHECK 이름과 식.
    fn renderer_checks(&self, t: &Table) -> RendererChecks {
        t.columns.iter().filter_map(|c| self.r.type_check(c).map(|check| (format!("{}${}", t.name.text, c.name.text), check))).collect()
    }
}
