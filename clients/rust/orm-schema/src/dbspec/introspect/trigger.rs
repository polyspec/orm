//! renderer가 쓰는 `immutable`과 `audit` trigger를 catalog trigger와 정확히
//! 비교해 그 setting을 알아본다.

use super::super::model::{audit_line, AuditList, Column, Name, Setting, SettingLine, Settings, Table};
use super::super::render::{Dialect, Renderer};
use super::{group, Catalog, ITable};
use regex::Regex;
use std::collections::BTreeMap;
use std::sync::LazyLock;

/// catalog trigger 하나를 renderer가 쓰는 statement 형식으로 다시 쓴 것.
/// PostgreSQL은 function과 trigger statement 두 개다.
pub(super) struct ITrigger {
    pub name: String,
    pub statements: Vec<String>,
}

static AUDIT_INSERT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^INSERT INTO [`"]([a-z0-9_]+)[`"] \(([^)]*)\) VALUES "#).expect("audit insert pattern"));
static AUDIT_COLUMN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^[`"]([a-z0-9_]+)[`"]$"#).expect("audit column pattern"));
static AUDIT_UPDATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"VALUES \('update', OLD\.[`"]([a-z0-9_]+)[`"],"#).expect("audit update pattern"));

impl Catalog {
    /// table마다 trigger 집합이 immutable이나 audit의 renderer 출력과 같으면 그
    /// setting을 더하고, 아니면 모든 trigger를 미지원으로 보고한다. table은 이름
    /// 순이다.
    pub(super) fn recognize_triggers(&mut self, dialect: Dialect, triggers: BTreeMap<String, Vec<ITrigger>>) {
        for (table, list) in triggers {
            let Some(t) = self.tables.iter().find(|t| t.name == table) else {
                for tr in &list {
                    self.report("trigger", &table, &tr.name, "the table is not read");
                }
                continue;
            };
            match trigger_setting(dialect, t, &list) {
                Some(setting) => self.table(&table).expect("table found above").settings.push(setting),
                None => {
                    for tr in &list {
                        self.report("trigger", &table, &tr.name, "the trigger is not the renderer output of immutable or audit");
                    }
                }
            }
        }
    }
}

/// trigger 집합이 같은 renderer 출력을 주는 setting 줄. 없으면 None이다.
fn trigger_setting(dialect: Dialect, t: &ITable, list: &[ITrigger]) -> Option<String> {
    let names: BTreeMap<&str, &ITrigger> = list.iter().map(|tr| (tr.name.as_str(), tr)).collect();
    let mut candidates: Vec<(Setting, String)> = Vec::new();
    if list.len() == 2 {
        candidates.push((Setting::Immutable, "immutable".to_owned()));
    }
    if let (Some(insert), 3) = (names.get(format!("{}$audit_insert", t.name).as_str()), list.len()) {
        let update = names.get(format!("{}$audit_update", t.name).as_str()).map_or(&[][..], |u| &u.statements[..]);
        let m = AUDIT_INSERT.captures(statement_body(&insert.statements));
        let u = AUDIT_UPDATE.captures(statement_body(update));
        if let Some(candidate) = m.zip(u).and_then(|(m, u)| audit_of(t, group(&m, 1), group(&m, 2), group(&u, 1))) {
            candidates.push(candidate);
        }
    }
    let r = Renderer { d: dialect };
    for (setting, line) in candidates {
        let want = r.triggers(&model(t, setting));
        let mut got: Option<Vec<String>> = Some(Vec::new());
        for w in trigger_order(&want) {
            match (names.get(w), got.as_mut()) {
                (Some(tr), Some(out)) => out.extend(tr.statements.iter().cloned()),
                _ => {
                    got = None;
                    break;
                }
            }
        }
        if got.unwrap_or_default() == want {
            return Some(line);
        }
    }
    None
}

/// audit insert trigger의 column 목록(action, previous, 기록하는 column)과 update trigger의
/// operation column으로 audit setting과 그 줄을 만든다. 기록하지 않는 column은 table의 column
/// 순서로 exclude 목록이 된다. 목록이 renderer 형식이 아니거나 operation column을 기록하지 않으면
/// None이다. 만든 setting은 다시 렌더링해 catalog trigger와 비교한다.
fn audit_of(t: &ITable, history: &str, quoted: &str, operation: &str) -> Option<(Setting, String)> {
    let names = quoted.split(", ").map(|q| AUDIT_COLUMN.captures(q).map(|m| group(&m, 1).to_owned())).collect::<Option<Vec<String>>>()?;
    let [action, previous, recorded @ ..] = names.as_slice() else { return None };
    if !recorded.iter().any(|c| c == operation) {
        return None;
    }
    let excluded: Vec<&str> = t.columns.iter().map(|c| c.name.as_str()).filter(|c| !recorded.iter().any(|r| r == c)).collect();
    let line = audit_line(history, operation, action, previous, "exclude", &excluded);
    let lists =
        if excluded.is_empty() { Vec::new() } else { vec![AuditList { keyword: name("exclude"), columns: excluded.iter().map(|c| name(c)).collect() }] };
    let setting = Setting::Audit { into: name(history), operation: name(operation), action: name(action), previous: name(previous), lists };
    Some((setting, line))
}

fn name(text: &str) -> Name {
    Name { text: text.to_owned(), pos: Default::default() }
}

/// renderer가 trigger를 쓰는 table model: column 이름과 type, setting 하나.
fn model(t: &ITable, setting: Setting) -> Table {
    let columns =
        t.columns.iter().map(|c| Column { comments: Vec::new(), name: name(&c.name), ty: c.typ, nullable: false, identity: None, default: None }).collect();
    let line = SettingLine { comments: Vec::new(), pos: Default::default(), setting };
    Table {
        comments: Vec::new(),
        name: name(&t.name),
        columns,
        primary: Vec::new(),
        uniques: Vec::new(),
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        checks: Vec::new(),
        settings: Some(Settings { comments: Vec::new(), lines: vec![line], closing: Vec::new() }),
        closing: Vec::new(),
    }
}

/// renderer statement 목록에서 trigger 이름을 순서대로 꺼낸다.
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

/// trigger statement에서 본문을 꺼낸다: PostgreSQL은 function의 BEGIN 뒤,
/// SQLite는 BEGIN 뒤, MySQL은 FOR EACH ROW 뒤다.
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
