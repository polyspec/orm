//! plan 없이 두 schema의 모든 차이를 나열한다(docs/plans.md, "Comparison"). rename이
//! 없으므로 table과 column은 이름으로만 맞춘다.

use super::model::{Setting, Table};
use super::plan_diff::{column_of, primary_key, same_default, widens};
use super::plan_objects::{expr_text, foreign_key_def, index_def, names_def, same};
use super::{emit, manifest, Diagnostic, Document};
use std::collections::BTreeMap;

/// 비교 대상이 schema text가 아닐 때의 diagnostic rule.
pub const RULE_COMPARE: &str = "compare";

/// 두 schema의 차이 하나. `name`은 column이나 객체의 이름이고, table 단위 차이에서는 비어 있다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Difference {
    pub kind: String,
    pub table: String,
    pub name: String,
}

/// 한 table 안에서 차이가 오는 순서.
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

/// plan 없이 `source`에서 `target`까지의 모든 차이를 돌려준다. 두 문서는 schema
/// text여야 하며, 아닌 쪽마다 `compare` diagnostic을 source, target 순으로 돌려준다.
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
    // 이름: (source table, target table)
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

/// 문서의 canonical emission이 그 문서 하나의 schema text인지 알려 준다.
fn is_schema_text(document: &Document) -> bool {
    manifest(&[document]).is_ok_and(|m| emit(document) == m.schema_text)
}

/// 두 쪽에 다 있는 table의 column, primary key, 객체, setting 차이를 더한다.
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
    let audit = |setting: &Setting| match setting {
        Setting::Audit { into, operation, action, previous } => Some(format!("{} {} {} {}", into.text, operation.text, action.text, previous.text)),
        _ => None,
    };
    compare_setting(&mut add, ("drop_immutable", "add_immutable"), setting_of(s, immutable), setting_of(t, immutable));
    compare_setting(&mut add, ("drop_audit", "add_audit"), setting_of(s, audit), setting_of(t, audit));
}

/// 객체의 이름과 정의를 문서 순서대로 모은다.
fn object_defs<'t, T>(items: &'t [T], def: impl Fn(&'t T) -> (&'t String, String)) -> Vec<(&'t str, String)> {
    items.iter().map(def).map(|(n, d)| (n.as_str(), d)).collect()
}

/// 이름으로 맞춘 객체가 한쪽에만 있으면 drop이나 add를, 정의가 다르면 둘 다 더한다.
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

/// table에 하나뿐인 setting이 한쪽에만 있으면 drop이나 add를, 정의가 다르면 둘 다 더한다.
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

/// `definition`이 고르는 setting의 정의이며, table에 없으면 `None`이다.
fn setting_of(t: &Table, definition: impl Fn(&Setting) -> Option<String>) -> Option<String> {
    t.settings.iter().flat_map(|s| &s.lines).find_map(|line| definition(&line.setting))
}
