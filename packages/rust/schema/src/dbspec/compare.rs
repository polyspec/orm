//! Lists every difference between two schemas without a plan (docs/plans.md, "Comparison"). Since no rename
//! is involved, tables and columns are matched by name only.

use super::model::{Setting, Table};
use super::plan_diff::{column_of, primary_key, same_default, widens};
use super::plan_objects::{expr_text, foreign_key_def, index_def, names_def, same};
use super::{emit, Diagnostic, Document};
use std::collections::BTreeMap;

/// Diagnostic rule for when a compared item is not schema text.
pub const RULE_COMPARE: &str = "compare";

/// One difference between two schemas. `name` is the name of a column or object; it is empty for a table-level difference.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Difference {
    pub kind: String,
    pub table: String,
    pub name: String,
}

/// The order in which differences appear within one table.
const KINDS: [&str; 21] = [
    "create_table",
    "drop_table",
    "drop_column",
    "add_column",
    "alter_column",
    "change_column_type",
    "change_column_identity",
    "reorder_columns",
    "change_primary_key",
    "drop_unique",
    "add_unique",
    "drop_index",
    "add_index",
    "drop_foreign_key",
    "add_foreign_key",
    "drop_check",
    "add_check",
    "drop_immutable",
    "add_immutable",
    "drop_audit",
    "add_audit",
];

/// Returns every difference from `source` to `target` without a plan. Both documents must be schema
/// text; for each side that is not, returns a `compare` diagnostic, in source, target order.
pub fn compare_schemas(source: &Document, target: &Document) -> Result<Vec<Difference>, Vec<Diagnostic>> {
    let diagnostics: Vec<Diagnostic> = [("source", source), ("target", target)]
        .into_iter()
        .filter(|(_, document)| !is_schema_text(document))
        .map(|(side, _)| Diagnostic {
            rule: RULE_COMPARE.to_owned(),
            line: 1,
            column: 1,
            message: format!(
                "the {side} is not a schema text: one document named schema in canonical form with its tables in name order and only the immutable and audit settings"
            ),
        })
        .collect();
    if !diagnostics.is_empty() {
        return Err(diagnostics);
    }
    // Name: (source table, target table)
    let mut tables: BTreeMap<&str, (Option<&Table>, Option<&Table>)> = BTreeMap::new();
    for t in &source.tables {
        tables.entry(t.name.text.as_str()).or_default().0 = Some(t);
    }
    for t in &target.tables {
        tables.entry(t.name.text.as_str()).or_default().1 = Some(t);
    }
    let mut differences = Vec::new();
    for (name, pair) in tables {
        let mut found: Vec<(&'static str, String)> = Vec::new();
        match pair {
            (None, Some(_)) => found.push(("create_table", String::new())),
            (Some(_), None) => found.push(("drop_table", String::new())),
            (Some(s), Some(t)) => compare_tables(s, t, &mut found),
            (None, None) => unreachable!("a table name comes from one of the documents"),
        }
        found.sort_by(|a, b| rank(a.0).cmp(&rank(b.0)).then_with(|| a.1.cmp(&b.1)));
        differences.extend(found.into_iter().map(|(kind, n)| Difference { kind: kind.to_owned(), table: name.to_owned(), name: n }));
    }
    Ok(differences)
}

fn rank(kind: &str) -> usize {
    KINDS.iter().position(|k| *k == kind).expect("every difference kind is listed")
}

/// Tells whether a document's canonical emission is the schema text of that one document. External document use lines are in document name order,
/// and that table must be in name order. The external document itself is not needed.
pub(crate) fn is_schema_text(document: &Document) -> bool {
    if document.name.text != "schema" {
        return false;
    }
    let mut schema = document.clone();
    schema.tables.sort_by(|a, b| a.name.text.cmp(&b.name.text));
    for line in &mut schema.uses {
        line.tables.sort_by(|a, b| a.text.cmp(&b.text));
        line.tables.dedup_by(|a, b| a.text == b.text);
    }
    emit(document) == super::emit::emit(&schema, super::emit::View::Schema)
}

/// Adds the differences in columns, primary key, objects, and settings of a table present on both sides.
fn compare_tables(s: &Table, t: &Table, found: &mut Vec<(&'static str, String)>) {
    let mut add = |kind: &'static str, name: &str| found.push((kind, name.to_owned()));
    for c in &s.columns {
        if column_of(t, &c.name.text).is_none() {
            add("drop_column", &c.name.text);
        }
    }
    let mut kept_target = Vec::new();
    let mut last_kept = None;
    let mut first_added = None;
    for (i, c) in t.columns.iter().enumerate() {
        let name = c.name.text.as_str();
        let Some(sc) = column_of(s, name) else {
            add("add_column", name);
            first_added.get_or_insert(i);
            continue;
        };
        kept_target.push(name);
        last_kept = Some(i);
        if (sc.ty != c.ty && widens(sc.ty, c.ty)) || sc.nullable != c.nullable || !same_default(&sc.default, &c.default) {
            add("alter_column", name);
        }
        if sc.ty != c.ty && !widens(sc.ty, c.ty) {
            add("change_column_type", name);
        }
        if sc.identity.is_some() != c.identity.is_some() {
            add("change_column_identity", name);
        }
    }
    let kept: Vec<&str> = s.columns.iter().map(|c| c.name.text.as_str()).filter(|n| column_of(t, n).is_some()).collect();
    if kept != kept_target || matches!((first_added, last_kept), (Some(a), Some(k)) if a < k) {
        add("reorder_columns", "");
    }
    if primary_key(s) != primary_key(t) {
        add("change_primary_key", "");
    }
    compare_objects(
        &mut add,
        ("drop_unique", "add_unique"),
        object_defs(&s.uniques, |u| (&u.name.text, names_def(&u.columns, same))),
        object_defs(&t.uniques, |u| (&u.name.text, names_def(&u.columns, same))),
    );
    compare_objects(
        &mut add,
        ("drop_index", "add_index"),
        object_defs(&s.indexes, |x| (&x.name.text, index_def(&x.columns, same))),
        object_defs(&t.indexes, |x| (&x.name.text, index_def(&x.columns, same))),
    );
    let foreign_key = |f: &super::model::ForeignKey| {
        let cols: Vec<&str> = f.columns.iter().map(|n| n.text.as_str()).collect();
        let refs: Vec<&str> = f.references.iter().map(|n| n.text.as_str()).collect();
        foreign_key_def(&cols, &f.table.text, &refs, f)
    };
    compare_objects(
        &mut add,
        ("drop_foreign_key", "add_foreign_key"),
        object_defs(&s.foreign_keys, |f| (&f.name.text, foreign_key(f))),
        object_defs(&t.foreign_keys, |f| (&f.name.text, foreign_key(f))),
    );
    compare_objects(
        &mut add,
        ("drop_check", "add_check"),
        object_defs(&s.checks, |k| (&k.name.text, expr_text(&k.expr, same))),
        object_defs(&t.checks, |k| (&k.name.text, expr_text(&k.expr, same))),
    );
    let immutable = |setting: &Setting| matches!(setting, Setting::Immutable).then(String::new);
    // audit compares even the columns on both sides that are not recorded. A column that exists on only one side
    // is left as a difference by add_column or drop_column.
    let audit = |setting: &Setting| match setting {
        Setting::Audit { into, column, references, action, previous, tables, .. } => {
            let mut def = format!("{} {} {} {} {}", into.text, column.text, references.text, action.text, previous.text);
            if let Some(tables) = tables {
                def.push_str(&format!(" tables {} {} {}", tables.table.text, tables.record.text, tables.name.text));
            }
            for c in t.columns.iter().filter(|c| s.column(&c.name.text).is_some() && !setting.records(&c.name.text)) {
                def.push(' ');
                def.push_str(&c.name.text);
            }
            Some(def)
        }
        _ => None,
    };
    compare_setting(&mut add, ("drop_immutable", "add_immutable"), setting_of(s, immutable), setting_of(t, immutable));
    compare_setting(&mut add, ("drop_audit", "add_audit"), setting_of(s, audit), setting_of(t, audit));
}

/// Collects the names and definitions of objects in document order.
fn object_defs<'t, T>(items: &'t [T], def: impl Fn(&'t T) -> (&'t String, String)) -> Vec<(&'t str, String)> {
    items.iter().map(def).map(|(n, d)| (n.as_str(), d)).collect()
}

/// If an object matched by name exists on only one side, adds a drop or an add; if the definitions differ, adds both.
fn compare_objects(
    add: &mut impl FnMut(&'static str, &str),
    (drop, add_kind): (&'static str, &'static str),
    source: Vec<(&str, String)>,
    target: Vec<(&str, String)>,
) {
    let def_of = |list: &[(&str, String)], name: &str| list.iter().find(|(n, _)| *n == name).map(|(_, d)| d.clone());
    for (name, def) in &source {
        if def_of(&target, name).as_ref() != Some(def) {
            add(drop, name);
        }
    }
    for (name, def) in &target {
        if def_of(&source, name).as_ref() != Some(def) {
            add(add_kind, name);
        }
    }
}

/// If a setting that is the only one of its kind in a table exists on only one side, adds a drop or an add; if the definitions differ, adds both.
fn compare_setting(add: &mut impl FnMut(&'static str, &str), (drop, add_kind): (&'static str, &'static str), source: Option<String>, target: Option<String>) {
    if source != target {
        if source.is_some() {
            add(drop, "");
        }
        if target.is_some() {
            add(add_kind, "");
        }
    }
}

/// The definition of the setting that `definition` selects; `None` if the table has none.
fn setting_of(t: &Table, definition: impl Fn(&Setting) -> Option<String>) -> Option<String> {
    t.settings.iter().flat_map(|s| &s.lines).find_map(|line| definition(&line.setting))
}
