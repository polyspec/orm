//! Plan documents and the plan chain (docs/plans.md, "Plan document" and
//! "Chain"): [`parse_plan`] reads a plan, [`emit_plan`] writes its canonical
//! text and [`chain`] orders plans from the empty database.

use super::parser::reserved;
use super::{manifest, parse, Diagnostic, Document};
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::LazyLock;

/// The rule of a plan document diagnostic.
pub const RULE_PLAN: &str = "plan";
/// The rule of a plan chain diagnostic.
pub const RULE_CHAIN: &str = "chain";

/// A parsed plan document. Only [`parse_plan`] makes one, so its target is
/// always a schema text whose hash is [`Plan::to`].
#[derive(Clone, Debug)]
pub struct Plan {
    pub(crate) name: String,
    pub(crate) from: Option<String>,
    pub(crate) rename_tables: Vec<TableRename>,
    pub(crate) rename_columns: Vec<ColumnRename>,
    pub(crate) drop_tables: Vec<String>,
    pub(crate) drop_columns: Vec<ColumnName>,
    pub(crate) schema: Document,
    pub(crate) schema_text: String,
    pub(crate) to: String,
}

impl Plan {
    /// The plan name of the `dbplan 1 <name>` line.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The `schemaHash` the plan starts from, or `None` for `from empty`.
    pub fn from(&self) -> Option<&str> {
        self.from.as_deref()
    }

    /// The `rename table` lines in plan order.
    pub fn rename_tables(&self) -> &[TableRename] {
        &self.rename_tables
    }

    /// The `rename column` lines in plan order.
    pub fn rename_columns(&self) -> &[ColumnRename] {
        &self.rename_columns
    }

    /// The tables of the `allow drop table` lines in plan order.
    pub fn drop_tables(&self) -> &[String] {
        &self.drop_tables
    }

    /// The columns of the `allow drop column` lines in plan order.
    pub fn drop_columns(&self) -> &[ColumnName] {
        &self.drop_columns
    }

    /// The target schema document.
    pub fn schema(&self) -> &Document {
        &self.schema
    }

    /// The target schema text.
    pub fn schema_text(&self) -> &str {
        &self.schema_text
    }

    /// The `schemaHash` of the target.
    pub fn to(&self) -> &str {
        &self.to
    }
}

/// `rename table <old> <new>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableRename {
    pub old: String,
    pub new: String,
}

/// `rename column <table>.<old> <new>`, where `table` is the target name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ColumnRename {
    pub table: String,
    pub old: String,
    pub new: String,
}

/// The source table and column of `allow drop column <table>.<name>`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ColumnName {
    pub table: String,
    pub name: String,
}

fn pattern(text: &str) -> Regex {
    Regex::new(text).expect("constant ASCII regex")
}

static PLAN_HEADER: LazyLock<Regex> = LazyLock::new(|| pattern(r"^dbplan 1 ([a-z][a-z0-9_]*)$"));
static PLAN_FROM: LazyLock<Regex> = LazyLock::new(|| pattern(r"^from (empty|sha256:[0-9a-f]{64})$"));
static PLAN_RENAME_TABLE: LazyLock<Regex> = LazyLock::new(|| pattern(r"^rename table ([a-z][a-z0-9_]*) ([a-z][a-z0-9_]*)$"));
static PLAN_RENAME_COLUMN: LazyLock<Regex> = LazyLock::new(|| pattern(r"^rename column ([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*) ([a-z][a-z0-9_]*)$"));
static PLAN_DROP_TABLE: LazyLock<Regex> = LazyLock::new(|| pattern(r"^allow drop table ([a-z][a-z0-9_]*)$"));
static PLAN_DROP_COLUMN: LazyLock<Regex> = LazyLock::new(|| pattern(r"^allow drop column ([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$"));

/// 줄 `line`의 `plan` diagnostic 하나.
fn plan_failure(line: usize, message: String) -> Vec<Diagnostic> {
    vec![Diagnostic { rule: RULE_PLAN.to_owned(), line, column: 1, message }]
}

/// 정규식이 잡은 이름 가운데 예약어이거나 63 byte보다 긴 첫 이름의 message.
fn plan_names(names: &[&str]) -> Option<String> {
    names.iter().find(|n| reserved(n) || n.len() > 63).map(|n| format!("name \"{n}\" is reserved or longer than 63 bytes"))
}

/// Reads a plan document. An invalid document is a `plan` diagnostic at its
/// line, or the diagnostics of its target located in the plan.
pub fn parse_plan(text: &str) -> Result<Plan, Vec<Diagnostic>> {
    let Some(body) = text.strip_suffix('\n') else {
        return Err(plan_failure(text.matches('\n').count() + 1, "a plan ends with a line end".to_owned()));
    };
    let lines: Vec<&str> = body.split('\n').collect();
    let name = match PLAN_HEADER.captures(lines[0]) {
        Some(m) if !reserved(&m[1]) && m[1].len() <= 63 => m[1].to_owned(),
        _ => return Err(plan_failure(1, "the first line is exactly `dbplan 1 <name>`".to_owned())),
    };
    let from_failure = || plan_failure(2, "the second line is `from empty` or `from <schemaHash>`".to_owned());
    let Some(from_line) = lines.get(1) else { return Err(from_failure()) };
    let Some(f) = PLAN_FROM.captures(from_line) else { return Err(from_failure()) };
    let from = if &f[1] == "empty" { None } else { Some(f[1].to_owned()) };
    let mut rename_tables = Vec::new();
    let mut rename_columns = Vec::new();
    let mut drop_tables = Vec::new();
    let mut drop_columns = Vec::new();
    let mut seen: HashMap<&str, usize> = HashMap::new();
    let mut given: HashMap<String, usize> = HashMap::new();
    let mut i = 2;
    while i < lines.len() && !lines[i].is_empty() {
        let (line, n) = (lines[i], i + 1);
        if let Some(at) = seen.get(line) {
            return Err(plan_failure(n, format!("line {at} repeats this line")));
        }
        seen.insert(line, n);
        if let Some(r) = PLAN_RENAME_TABLE.captures(line) {
            if let Some(message) = plan_names(&[&r[1], &r[2]]) {
                return Err(plan_failure(n, message));
            }
            let key = format!("table {}", &r[2]);
            if let Some(at) = given.get(&key) {
                return Err(plan_failure(n, format!("line {at} renames another table to {}", &r[2])));
            }
            given.insert(key, n);
            rename_tables.push(TableRename { old: r[1].to_owned(), new: r[2].to_owned() });
        } else if let Some(r) = PLAN_RENAME_COLUMN.captures(line) {
            if let Some(message) = plan_names(&[&r[1], &r[2], &r[3]]) {
                return Err(plan_failure(n, message));
            }
            let key = format!("column {}.{}", &r[1], &r[3]);
            if let Some(at) = given.get(&key) {
                return Err(plan_failure(n, format!("line {at} renames another column to {}.{}", &r[1], &r[3])));
            }
            given.insert(key, n);
            rename_columns.push(ColumnRename { table: r[1].to_owned(), old: r[2].to_owned(), new: r[3].to_owned() });
        } else if let Some(r) = PLAN_DROP_TABLE.captures(line) {
            if let Some(message) = plan_names(&[&r[1]]) {
                return Err(plan_failure(n, message));
            }
            drop_tables.push(r[1].to_owned());
        } else if let Some(r) = PLAN_DROP_COLUMN.captures(line) {
            if let Some(message) = plan_names(&[&r[1], &r[2]]) {
                return Err(plan_failure(n, message));
            }
            drop_columns.push(ColumnName { table: r[1].to_owned(), name: r[2].to_owned() });
        } else {
            return Err(plan_failure(n, "a header line is `rename table`, `rename column`, `allow drop table` or `allow drop column`".to_owned()));
        }
        i += 1;
    }
    if i >= lines.len() {
        return Err(plan_failure(i + 1, "a blank line and the target schema text follow the header".to_owned()));
    }
    let offset = i + 1;
    let schema_text = format!("{}\n", lines[offset..].join("\n"));
    let schema = parse(&schema_text, &BTreeMap::new()).map_err(|mut diagnostics| {
        for d in &mut diagnostics {
            d.line += offset;
        }
        diagnostics
    })?;
    let target = manifest(&[&schema])?;
    if target.schema_text != schema_text {
        return Err(plan_failure(
            offset + 1,
            "the target is not a schema text: one document named schema in canonical form with its tables in name order and only the immutable and audit settings"
                .to_owned(),
        ));
    }
    if from.as_deref() == Some(target.schema_hash.as_str()) {
        return Err(plan_failure(2, "the plan starts from its own target schema".to_owned()));
    }
    Ok(Plan { name, from, rename_tables, rename_columns, drop_tables, drop_columns, schema, schema_text: target.schema_text, to: target.schema_hash })
}

/// `key` 순으로 정렬한 참조. 같은 key는 원래 순서를 지킨다.
pub(crate) fn sorted_by<T, K: Ord>(items: &[T], key: impl Fn(&T) -> K) -> Vec<&T> {
    let mut sorted: Vec<&T> = items.iter().collect();
    sorted.sort_by_key(|item| key(item));
    sorted
}

/// Writes the canonical plan document: the `rename table`, `rename column`,
/// `allow drop table` and `allow drop column` lines in that order, each in
/// name order, then a blank line and the target schema text.
pub fn emit_plan(plan: &Plan) -> String {
    let mut out = format!("dbplan 1 {}\n", plan.name);
    match &plan.from {
        None => out.push_str("from empty\n"),
        Some(from) => out.push_str(&format!("from {from}\n")),
    }
    for r in sorted_by(&plan.rename_tables, |r| r.old.clone()) {
        out.push_str(&format!("rename table {} {}\n", r.old, r.new));
    }
    for r in sorted_by(&plan.rename_columns, |r| format!("{}.{}", r.table, r.old)) {
        out.push_str(&format!("rename column {}.{} {}\n", r.table, r.old, r.new));
    }
    for t in sorted_by(&plan.drop_tables, |t| t.clone()) {
        out.push_str(&format!("allow drop table {t}\n"));
    }
    for c in sorted_by(&plan.drop_columns, |c| format!("{}.{}", c.table, c.name)) {
        out.push_str(&format!("allow drop column {}.{}\n", c.table, c.name));
    }
    out.push('\n');
    out.push_str(&plan.schema_text);
    out
}

fn chain_failure(message: String) -> Vec<Diagnostic> {
    vec![Diagnostic { rule: RULE_CHAIN.to_owned(), line: 1, column: 1, message }]
}

/// Orders `plans` into the one chain that starts from the empty database, or
/// returns the `chain` diagnostics that name the plans: plans that start from
/// the same schema, a missing `from empty` plan, a cycle and unreached plans.
pub fn chain(plans: &[Plan]) -> Result<Vec<&Plan>, Vec<Diagnostic>> {
    // None(from empty)이 가장 앞에 오는 from 순서
    let mut by_from: BTreeMap<Option<&str>, Vec<usize>> = BTreeMap::new();
    for (index, plan) in plans.iter().enumerate() {
        by_from.entry(plan.from()).or_default().push(index);
    }
    let mut out = Vec::new();
    for indexes in by_from.values().filter(|indexes| indexes.len() > 1) {
        let mut names: Vec<&str> = indexes.iter().map(|&i| plans[i].name()).collect();
        names.sort_unstable();
        out.extend(chain_failure(format!("plans {} start from the same schema", names.join(", "))));
    }
    let Some(first) = by_from.get(&None).map(|indexes| indexes[0]) else {
        out.extend(chain_failure("no plan starts from empty".to_owned()));
        return Err(out);
    };
    if !out.is_empty() {
        return Err(out);
    }
    let mut ordered = Vec::new();
    let mut visited = BTreeSet::new();
    let mut current = Some(first);
    while let Some(index) = current {
        let plan = &plans[index];
        if !visited.insert(index) {
            return Err(chain_failure(format!("plan {} closes a cycle", plan.name)));
        }
        ordered.push(plan);
        current = by_from.get(&Some(plan.to())).map(|indexes| indexes[0]);
    }
    let mut unreached: Vec<&str> = (0..plans.len()).filter(|i| !visited.contains(i)).map(|i| plans[i].name()).collect();
    if !unreached.is_empty() {
        unreached.sort_unstable();
        return Err(chain_failure(format!("no chain reaches plans {}", unreached.join(", "))));
    }
    Ok(ordered)
}
