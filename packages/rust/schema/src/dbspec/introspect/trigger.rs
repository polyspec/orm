//! Compares the `immutable` and `audit` triggers the renderer writes exactly with the catalog triggers
//! and recognizes that setting.

use super::super::model::{audit_line, AuditList, AuditTables, Column, Name, Setting, SettingLine, Settings, Table};
use super::super::names::renderer_name;
use super::super::render::{Dialect, Renderer};
use super::{group, Catalog, ITable};
use regex::Regex;
use std::collections::BTreeMap;
use std::sync::LazyLock;

/// One catalog trigger rewritten in the statement form the renderer writes.
/// PostgreSQL has two parts: a function and a trigger statement.
pub(super) struct ITrigger {
    pub name: String,
    pub statements: Vec<String>,
}

static AUDIT_INSERT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^INSERT INTO [`"]([a-z0-9_]+)[`"] \(([^)]*)\) VALUES "#).expect("audit insert pattern"));
static AUDIT_COLUMN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^[`"]([a-z0-9_]+)[`"]$"#).expect("audit column pattern"));
static AUDIT_TABLES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"; INSERT INTO [`"]([a-z0-9_]+)[`"] \([`"]([a-z0-9_]+)[`"], [`"]([a-z0-9_]+)[`"]\) VALUES \(NEW\."#).expect("audit tables pattern")
});
static AUDIT_UPDATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"VALUES \('update', OLD\.[`"]([a-z0-9_]+)[`"],"#).expect("audit update pattern"));

impl Catalog {
    /// For each table, if the trigger set equals the renderer output of immutable or audit, that
    /// setting is added; otherwise all triggers are reported as unsupported. Tables are
    /// in name order.
    pub(super) fn recognize_triggers(&mut self, dialect: Dialect, triggers: BTreeMap<String, Vec<ITrigger>>) {
        for (table, list) in triggers {
            let Some(t) = self.tables.iter().find(|t| t.name == table) else {
                for tr in &list {
                    self.report("trigger", &table, &tr.name, "the table is not read");
                }
                continue;
            };
            match trigger_setting(dialect, t, &list) {
                Some(lines) => self.table(&table).expect("table found above").settings.extend(lines),
                None => {
                    for tr in &list {
                        self.report("trigger", &table, &tr.name, "the trigger is not the renderer output of immutable or audit");
                    }
                }
            }
        }
    }
}

/// The setting line whose trigger set gives the same renderer output. None if there is none.
/// Recognizes each setting by its own trigger name (the recomputed renderer name), and the trigger set must match the union of the recognized settings'
/// renderer output, equal in both name and content, and returns those setting lines only then; otherwise None (docs/dialects.md
/// "Triggers"). A table that writes two settings together is the sum of the two outputs; it is not judged by count.
fn trigger_setting(dialect: Dialect, t: &ITable, list: &[ITrigger]) -> Option<Vec<String>> {
    let names: BTreeMap<&str, &ITrigger> = list.iter().map(|tr| (tr.name.as_str(), tr)).collect();
    let mut found: Vec<(Setting, String)> = Vec::new();
    if ["immutable_update", "immutable_delete"].iter().any(|event| names.contains_key(renderer_name(&t.name, event).as_str())) {
        found.push((Setting::Immutable, "immutable".to_owned()));
    }
    if let Some(insert) = names.get(renderer_name(&t.name, "audit_insert").as_str()) {
        let update = names.get(renderer_name(&t.name, "audit_update").as_str()).map_or(&[][..], |u| &u.statements[..]);
        let m = AUDIT_INSERT.captures(statement_body(&insert.statements));
        let u = AUDIT_UPDATE.captures(statement_body(update));
        let tables = AUDIT_TABLES.captures(statement_body(&insert.statements)).map(|c| AuditTables {
            table: name(group(&c, 1)),
            record: name(group(&c, 2)),
            name: name(group(&c, 3)),
        });
        if let Some(candidate) = m.zip(u).and_then(|(m, u)| audit_of(t, group(&m, 1), group(&m, 2), group(&u, 1), tables)) {
            found.push(candidate);
        }
    }
    if found.is_empty() {
        return None;
    }
    let (settings, lines): (Vec<Setting>, Vec<String>) = found.into_iter().unzip();
    let want = Renderer { d: dialect }.triggers(&model(t, settings));
    let wanted = trigger_order(&want);
    if wanted.len() != list.len() {
        return None;
    }
    let mut got = Vec::new();
    for w in wanted {
        let tr = names.get(w)?;
        got.extend(tr.statements.iter().cloned());
    }
    (got == want).then_some(lines)
}

/// The column lists of the audit insert trigger (action, previous, and the recorded columns) and of the update trigger
/// make the audit setting and its line from the audit columns. The audit record table has only one audit column
/// is the table that the table's foreign key points to. Columns not recorded are excluded in table column order
/// become the list. Returns None if the list is not in renderer form, does not record the audit column, or its foreign key
/// is not exactly one. The setting made is rendered again and compared with the catalog trigger.
fn audit_of(t: &ITable, history: &str, quoted: &str, column: &str, tables: Option<AuditTables>) -> Option<(Setting, String)> {
    let names = quoted.split(", ").map(|q| AUDIT_COLUMN.captures(q).map(|m| group(&m, 1).to_owned())).collect::<Option<Vec<String>>>()?;
    let [action, previous, recorded @ ..] = names.as_slice() else { return None };
    if !recorded.iter().any(|c| c == column) {
        return None;
    }
    let mut keys = t.fks.iter().filter(|f| f.columns.len() == 1 && f.columns[0] == column);
    let references = keys.next()?.table.clone();
    if keys.next().is_some() {
        return None;
    }
    let excluded: Vec<&str> = t.columns.iter().map(|c| c.name.as_str()).filter(|c| !recorded.iter().any(|r| r == c)).collect();
    let line = audit_line(history, column, &references, action, previous, tables.as_ref(), "exclude", &excluded);
    let lists =
        if excluded.is_empty() { Vec::new() } else { vec![AuditList { keyword: name("exclude"), columns: excluded.iter().map(|c| name(c)).collect() }] };
    let setting = Setting::Audit {
        into: name(history),
        column: name(column),
        references: name(&references),
        action: name(action),
        previous: name(previous),
        tables,
        lists,
    };
    Some((setting, line))
}

fn name(text: &str) -> Name {
    Name { text: text.to_owned(), pos: Default::default() }
}

/// The table model the renderer writes triggers from: column names and types, one setting.
fn model(t: &ITable, settings: Vec<Setting>) -> Table {
    let columns =
        t.columns.iter().map(|c| Column { comments: Vec::new(), name: name(&c.name), ty: c.typ, nullable: false, identity: None, default: None }).collect();
    let lines = settings.into_iter().map(|setting| SettingLine { comments: Vec::new(), pos: Default::default(), setting }).collect();
    Table {
        comments: Vec::new(),
        name: name(&t.name),
        columns,
        primary: Vec::new(),
        uniques: Vec::new(),
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        checks: Vec::new(),
        settings: Some(Settings { comments: Vec::new(), lines, closing: Vec::new() }),
        closing: Vec::new(),
    }
}

/// Takes the trigger names in order from the renderer statement list.
fn trigger_order(statements: &[String]) -> Vec<&str> {
    statements
        .iter()
        .filter_map(|s| s.strip_prefix("CREATE TRIGGER "))
        .filter_map(|rest| {
            let quote = rest.chars().next()?;
            let inner = &rest[quote.len_utf8()..];
            inner.find(quote).map(|end| &inner[..end])
        })
        .collect()
}

/// Takes the body from a trigger statement: in PostgreSQL, after BEGIN of the function,
/// in SQLite after BEGIN, and in MySQL after FOR EACH ROW.
fn statement_body(statements: &[String]) -> &str {
    for s in statements {
        for marker in ["$$BEGIN ", "FOR EACH ROW BEGIN ", "FOR EACH ROW "] {
            if let Some(i) = s.find(marker) {
                return &s[i + marker.len()..];
            }
        }
    }
    ""
}
