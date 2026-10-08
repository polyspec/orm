//! The diff of a plan (docs/plans.md, "Diff"): the changes from the source
//! schema to the plan's target and the changes it refuses.

use super::model::{Column, DefaultValue, Table, Type};
use super::plan::{sorted_by, ColumnName, ColumnRename, Plan, TableRename, RULE_PLAN};
use super::{manifest, Diagnostic, Document};
use std::collections::{BTreeMap, BTreeSet};

/// One change of a diff. `table` is the target name, except for
/// `drop_table` and the `drop_*` objects, which name the source table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub kind: String,
    pub table: String,
    pub name: String,
}

/// unique, index, foreign key, check 객체 하나. kind, name 순으로 정렬한다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct ObjectRef<'d> {
    pub kind: &'static str,
    pub name: &'d str,
}

/// diff와 statement 렌더링이 함께 쓰는 diff 결과.
pub(crate) struct PlanDiff<'d> {
    /// 이름: table
    pub source: BTreeMap<&'d str, &'d Table>,
    pub target: BTreeMap<&'d str, &'d Table>,
    /// target table: source table
    pub table_of: BTreeMap<&'d str, &'d str>,
    /// target table: target column: source column
    pub column_of: BTreeMap<&'d str, BTreeMap<&'d str, &'d str>>,
    pub created: Vec<&'d str>,
    pub dropped: Vec<&'d str>,
    /// target 이름 순
    pub matched: Vec<&'d str>,
    pub added: BTreeMap<&'d str, Vec<&'d str>>,
    pub removed: BTreeMap<&'d str, Vec<&'d str>>,
    pub altered: BTreeMap<&'d str, Vec<&'d str>>,
    pub renamed_tables: Vec<&'d TableRename>,
    pub renamed_columns: Vec<&'d ColumnRename>,
    /// source table: 지울 객체
    pub drop_objects: BTreeMap<&'d str, Vec<ObjectRef<'d>>>,
    /// target table: 더할 객체
    pub add_objects: BTreeMap<&'d str, Vec<ObjectRef<'d>>>,
    /// trigger가 바뀌는 target table
    pub triggers: BTreeSet<&'d str>,
    pub changes: Vec<Change>,
}

/// Returns the changes from `source`, or the empty schema when it is `None`,
/// to the target of `plan`, or the `plan` diagnostics of a source whose
/// `schemaHash` is not the plan's `from` and of refused changes.
pub fn diff(source: Option<&Document>, plan: &Plan) -> Result<Vec<Change>, Vec<Diagnostic>> {
    diff_plan(source, plan).map(|d| d.changes)
}

pub(crate) fn plan_error(message: String) -> Diagnostic {
    Diagnostic { rule: RULE_PLAN.to_owned(), line: 1, column: 1, message }
}

fn hash_or_empty(hash: Option<&str>) -> &str {
    hash.unwrap_or("empty")
}

pub(crate) fn renamed_or<'a>(renamed: Option<&BTreeMap<&'a str, &'a str>>, name: &'a str) -> &'a str {
    renamed.and_then(|m| m.get(name).copied()).unwrap_or(name)
}

pub(crate) fn column_of<'t>(t: &'t Table, name: &str) -> Option<&'t Column> {
    t.column(name)
}

/// table의 primary key column 이름.
pub(crate) fn primary_key(t: &Table) -> Vec<&str> {
    t.primary.iter().flat_map(|k| k.columns.iter().map(|n| n.text.as_str())).collect()
}

pub(crate) fn diff_plan<'d>(source: Option<&'d Document>, plan: &'d Plan) -> Result<PlanDiff<'d>, Vec<Diagnostic>> {
    let from = match source {
        None => None,
        Some(source) => Some(manifest(&[source])?.schema_hash),
    };
    if from.as_deref() != plan.from() {
        return Err(vec![plan_error(format!(
            "the plan starts from {}, and the source schema is {}",
            hash_or_empty(plan.from()),
            hash_or_empty(from.as_deref())
        ))]);
    }
    let mut d = PlanDiff {
        source: BTreeMap::new(),
        target: BTreeMap::new(),
        table_of: BTreeMap::new(),
        column_of: BTreeMap::new(),
        created: Vec::new(),
        dropped: Vec::new(),
        matched: Vec::new(),
        added: BTreeMap::new(),
        removed: BTreeMap::new(),
        altered: BTreeMap::new(),
        renamed_tables: Vec::new(),
        renamed_columns: Vec::new(),
        drop_objects: BTreeMap::new(),
        add_objects: BTreeMap::new(),
        triggers: BTreeSet::new(),
        changes: Vec::new(),
    };
    if let Some(source) = source {
        for t in &source.tables {
            d.source.insert(&t.name.text, t);
        }
    }
    for t in &plan.schema().tables {
        d.target.insert(&t.name.text, t);
    }
    let mut out = Vec::new();
    // table rename
    let mut renamed_from: BTreeMap<&str, &str> = BTreeMap::new(); // source: target
    for r in sorted_by(plan.rename_tables(), |r| r.old.clone()) {
        if !d.source.contains_key(r.old.as_str()) {
            out.push(plan_error(format!("rename table {}: the source has no table {}", r.old, r.old)));
        } else if d.source.contains_key(r.new.as_str()) {
            out.push(plan_error(format!("rename table {}: the source already has a table {}", r.old, r.new)));
        } else if !d.target.contains_key(r.new.as_str()) {
            out.push(plan_error(format!("rename table {}: the target has no table {}", r.old, r.new)));
        } else {
            renamed_from.insert(&r.old, &r.new);
            d.renamed_tables.push(r);
        }
    }
    for &name in d.source.keys() {
        let t = renamed_or(Some(&renamed_from), name);
        if d.target.contains_key(t) {
            d.table_of.insert(t, name);
        } else {
            d.dropped.push(name);
        }
    }
    for &name in d.target.keys() {
        if d.table_of.contains_key(name) {
            d.matched.push(name);
        } else {
            d.created.push(name);
        }
    }
    // table drop permission
    for t in plan.drop_tables() {
        if !d.dropped.contains(&t.as_str()) {
            out.push(plan_error(format!("allow drop table {t} drops nothing")));
        }
    }
    for t in &d.dropped {
        if !plan.drop_tables().iter().any(|allowed| allowed == t) {
            out.push(plan_error(format!("table {t} is dropped without allow drop table {t}")));
        }
    }
    // column rename
    let mut renamed_column: BTreeMap<&str, BTreeMap<&str, &str>> = BTreeMap::new(); // target table: source column: target column
    for r in sorted_by(plan.rename_columns(), |r| format!("{}.{}", r.table, r.old)) {
        let Some(&src) = d.table_of.get(r.table.as_str()) else {
            out.push(plan_error(format!("rename column {}.{}: {} is not a table of both schemas", r.table, r.old, r.table)));
            continue;
        };
        if column_of(d.source[src], &r.old).is_none() {
            out.push(plan_error(format!("rename column {}.{}: the source table has no column {}", r.table, r.old, r.old)));
        } else if column_of(d.source[src], &r.new).is_some() {
            out.push(plan_error(format!("rename column {}.{}: the source table already has a column {}", r.table, r.old, r.new)));
        } else if column_of(d.target[r.table.as_str()], &r.new).is_none() {
            out.push(plan_error(format!("rename column {}.{}: the target table has no column {}", r.table, r.old, r.new)));
        } else {
            renamed_column.entry(&r.table).or_default().insert(&r.old, &r.new);
            d.renamed_columns.push(r);
        }
    }
    let mut used_column_permissions: BTreeSet<ColumnName> = BTreeSet::new();
    // matched table의 column
    for &name in &d.matched {
        let (src, tgt) = (d.source[d.table_of[name]], d.target[name]);
        let renamed = renamed_column.get(name);
        let mut columns: BTreeMap<&str, &str> = BTreeMap::new();
        for c in &src.columns {
            let n = renamed_or(renamed, &c.name.text);
            if column_of(tgt, n).is_none() {
                let reference = ColumnName { table: src.name.text.clone(), name: c.name.text.clone() };
                if !plan.drop_columns().contains(&reference) {
                    out.push(plan_error(format!(
                        "column {}.{} is dropped without allow drop column {}.{}",
                        src.name.text, c.name.text, src.name.text, c.name.text
                    )));
                }
                used_column_permissions.insert(reference);
                d.removed.entry(name).or_default().push(&c.name.text);
                continue;
            }
            columns.insert(n, &c.name.text);
        }
        for c in &tgt.columns {
            let Some(&old) = columns.get(c.name.text.as_str()) else {
                if !c.nullable && c.default.is_none() {
                    out.push(plan_error(format!(
                        "column {name}.{} is added non-null without a default; add it null, fill it, and make it non-null in a later plan",
                        c.name.text
                    )));
                }
                if c.identity.is_some() {
                    out.push(plan_error(format!("column {name}.{} adds an identity, which changes the primary key", c.name.text)));
                }
                d.added.entry(name).or_default().push(&c.name.text);
                continue;
            };
            let sc = column_of(src, old).expect("a kept column is a source column");
            if sc.identity.is_some() != c.identity.is_some() {
                out.push(plan_error(format!("column {name}.{} changes identity; it needs a new table", c.name.text)));
                continue;
            }
            if sc.ty != c.ty && !widens(sc.ty, c.ty) {
                out.push(plan_error(format!(
                    "column {name}.{} changes type from {} to {}, which does not keep every value; it needs a new column",
                    c.name.text,
                    sc.ty.render(),
                    c.ty.render()
                )));
                continue;
            }
            if sc.ty != c.ty || sc.nullable != c.nullable || !same_default(&sc.default, &c.default) {
                d.altered.entry(name).or_default().push(&c.name.text);
            }
        }
        // PostgreSQL은 column 자리를 정하지 못하므로 남는 column의 순서는 그대로이고
        // 더한 column은 남는 column 뒤에 온다.
        let kept: Vec<&str> = src.columns.iter().map(|c| renamed_or(renamed, &c.name.text)).filter(|n| column_of(tgt, n).is_some()).collect();
        let kept_target: Vec<&str> = tgt.columns.iter().map(|c| c.name.text.as_str()).filter(|n| columns.contains_key(n)).collect();
        let last_kept = tgt.columns.iter().rposition(|c| columns.contains_key(c.name.text.as_str()));
        if kept != kept_target {
            out.push(plan_error(format!("table {name} reorders its columns; columns keep their order")));
        }
        for (i, c) in tgt.columns.iter().enumerate() {
            if !columns.contains_key(c.name.text.as_str()) && last_kept.is_some_and(|last| i < last) {
                out.push(plan_error(format!("column {name}.{} is added before a kept column; added columns come last", c.name.text)));
            }
        }
        let source_key: Vec<&str> = primary_key(src).into_iter().map(|k| renamed_or(renamed, k)).collect();
        if source_key != primary_key(tgt) {
            out.push(plan_error(format!("table {name} changes its primary key; it needs a new table")));
        }
        d.column_of.insert(name, columns);
    }
    for c in plan.drop_columns() {
        if !used_column_permissions.contains(c) {
            out.push(plan_error(format!("allow drop column {}.{} drops nothing", c.table, c.name)));
        }
    }
    if !out.is_empty() {
        return Err(out);
    }
    d.objects(&renamed_from, &renamed_column);
    d.trigger_changes();
    d.collect_changes();
    Ok(d)
}

/// 세 database에서 모든 값을 지키는 type 변경인지 알려 준다.
pub(crate) fn widens(from: Type, to: Type) -> bool {
    match (from, to) {
        (Type::I16, Type::I32 | Type::I64) | (Type::I32, Type::I64) | (Type::Varchar(_), Type::Text) => true,
        (Type::Varchar(n), Type::Varchar(m)) => m >= n,
        (Type::Decimal(p, s), Type::Decimal(q, t)) => t == s && q >= p,
        (Type::Time(p), Type::Time(q)) | (Type::DateTime(p), Type::DateTime(q)) => q >= p,
        _ => false,
    }
}

pub(crate) fn same_default(a: &Option<DefaultValue>, b: &Option<DefaultValue>) -> bool {
    a == b
}

impl<'d> PlanDiff<'d> {
    pub(crate) fn collect_changes(&mut self) {
        let mut changes = Vec::new();
        let mut add = |kind: &str, table: &str, name: &str| changes.push(Change { kind: kind.to_owned(), table: table.to_owned(), name: name.to_owned() });
        for &name in &self.matched {
            if self.triggers.contains(name) && has_triggers(self.source[self.table_of[name]]) {
                add("drop_triggers", self.table_of[name], "");
            }
        }
        for (s, objects) in &self.drop_objects {
            for o in objects {
                add(&format!("drop_{}", o.kind), s, o.name);
            }
        }
        for r in sorted_by(&self.renamed_tables, |r| r.old.clone()) {
            add("rename_table", &r.old, &r.new);
        }
        for r in sorted_by(&self.renamed_columns, |r| format!("{}.{}", r.table, r.old)) {
            add("rename_column", &r.table, &format!("{} {}", r.old, r.new));
        }
        for &name in &self.matched {
            for c in self.removed.get(name).into_iter().flatten() {
                add("drop_column", self.table_of[name], c);
            }
        }
        for name in &self.dropped {
            add("drop_table", name, "");
        }
        for name in &self.created {
            add("create_table", name, "");
        }
        for &name in &self.matched {
            for c in self.added.get(name).into_iter().flatten() {
                add("add_column", name, c);
            }
            for c in self.altered.get(name).into_iter().flatten() {
                add("alter_column", name, c);
            }
        }
        for (t, objects) in &self.add_objects {
            for o in objects {
                add(&format!("add_{}", o.kind), t, o.name);
            }
        }
        for &name in &self.matched {
            if self.triggers.contains(name) && has_triggers(self.target[name]) {
                add("create_triggers", name, "");
            }
        }
        self.changes = changes;
    }
}

/// `immutable`이나 `audit` setting이 trigger를 만드는 table인지 알려 준다.
pub(crate) fn has_triggers(t: &Table) -> bool {
    use super::model::Setting;
    t.settings.as_ref().is_some_and(|s| s.lines.iter().any(|l| matches!(l.setting, Setting::Immutable | Setting::Audit { .. })))
}
