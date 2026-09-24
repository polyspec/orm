//! The `%% orm:audit_log` and `%% orm:audit` directives.

use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;

use super::json::{self, Obj, J};
use super::manifest::{BuildError, Manifest};
use super::mermaid::OrmDirective;

/// The tables audit triggers write to and the transaction setting that
/// carries the current operation id.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct AuditLog {
    pub operation: AuditTable,
    pub context: String,
    pub change: AuditTable,
}

/// A physical table and the ordered columns an audit directive names on it.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct AuditTable {
    pub table: String,
    #[serde(default, deserialize_with = "super::manifest::null_default")]
    pub columns: Vec<String>,
}

/// An audit trigger declared on one entity.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Audit {
    pub entity: String,
    pub mode: String,
    #[serde(default)]
    pub service: String,
    #[serde(default, deserialize_with = "super::manifest::null_default")]
    pub redact: Vec<Vec<String>>,
}

static RE_AUDIT_TABLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\(([^()]*)\)$").expect("audit table pattern"));
static RE_AUDIT_CONTEXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_][A-Za-z0-9_.]{0,63}$").expect("audit context pattern"));
static RE_AUDIT_SEGMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").expect("audit segment pattern"));

fn berr(line: usize, msg: impl Into<String>) -> BuildError {
    BuildError { line, msg: msg.into() }
}

fn arg<'a>(x: &'a OrmDirective, key: &str) -> &'a str {
    x.args.get(key).map(String::as_str).unwrap_or("")
}

fn split_list(value: &str) -> Vec<String> {
    value.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect()
}

/// Reads table(column, ...). The tables are references like the target of
/// `%% orm:foreign`: they may belong to another manifest installed on the same
/// connection, so only the syntax and the column count are checked.
fn audit_table(x: &OrmDirective, option: &str, width: usize) -> Result<AuditTable, BuildError> {
    let Some(caps) = RE_AUDIT_TABLE.captures(arg(x, option)) else {
        return Err(berr(x.line, format!("%% orm:audit_log: {option} must be table(column, ...)")));
    };
    let columns = split_list(&caps[2]);
    if columns.len() != width {
        return Err(berr(x.line, format!("%% orm:audit_log: {option} needs {width} columns")));
    }
    for column in &columns {
        if !RE_AUDIT_SEGMENT.is_match(column) {
            return Err(berr(x.line, format!("%% orm:audit_log: {option} has an invalid column {column}")));
        }
    }
    for (i, column) in columns.iter().enumerate() {
        if columns[..i].contains(column) {
            return Err(berr(x.line, format!("%% orm:audit_log: {option} repeats column {column}")));
        }
    }
    Ok(AuditTable { table: caps[1].to_owned(), columns })
}

pub(super) fn add_audit_log(m: &mut Manifest, x: &OrmDirective) -> Result<(), BuildError> {
    if m.audit_log.is_some() {
        return Err(berr(x.line, "%% orm:audit_log: declared more than once"));
    }
    for option in ["operation", "context", "change"] {
        if arg(x, option).is_empty() {
            return Err(berr(x.line, format!("%% orm:audit_log: {option} is required")));
        }
    }
    let operation = audit_table(x, "operation", 2)?;
    let change = audit_table(x, "change", 7)?;
    if operation.table == change.table {
        return Err(berr(x.line, "%% orm:audit_log: operation and change must be different tables"));
    }
    let context = arg(x, "context");
    if !RE_AUDIT_CONTEXT.is_match(context) {
        return Err(berr(x.line, format!("%% orm:audit_log: invalid context {context}")));
    }
    m.audit_log = Some(AuditLog { operation, context: context.to_owned(), change });
    Ok(())
}

pub(super) fn add_audit(m: &mut Manifest, x: &OrmDirective) -> Result<(), BuildError> {
    let name = arg(x, "entity");
    let Some(e) = m.entities.get(name) else {
        return Err(berr(x.line, format!("%% orm:audit: unknown entity {name}")));
    };
    if m.audits.iter().any(|a| a.entity == name) {
        return Err(berr(x.line, format!("%% orm:audit: entity {name} is declared more than once")));
    }
    let mode = arg(x, "mode");
    if mode != "changes" && mode != "operations" {
        return Err(berr(x.line, "%% orm:audit: mode must be changes or operations"));
    }
    let mut audit = Audit { entity: name.to_owned(), mode: mode.to_owned(), service: arg(x, "service").to_owned(), redact: Vec::new() };
    if !audit.service.is_empty() && e.column(&audit.service).is_none() {
        return Err(berr(x.line, format!("%% orm:audit: unknown column {name}.{}", audit.service)));
    }
    if let Some(value) = x.args.get("redact") {
        for item in value.split(',') {
            let path: Vec<String> = item.split('.').map(str::to_owned).collect();
            if path.iter().any(|segment| !RE_AUDIT_SEGMENT.is_match(segment)) {
                return Err(berr(x.line, format!("%% orm:audit: invalid redact path {item}")));
            }
            if e.column(&path[0]).is_none() {
                return Err(berr(x.line, format!("%% orm:audit: unknown column {name}.{}", path[0])));
            }
            for previous in &audit.redact {
                let n = previous.len().min(path.len());
                if previous[..n] == path[..n] {
                    return Err(berr(x.line, format!("%% orm:audit: redact paths overlap: {item}")));
                }
            }
            audit.redact.push(path);
        }
    }
    m.audits.push(audit);
    Ok(())
}

/// Checks the declarations that depend on each other and sorts the audits by
/// entity.
pub(super) fn finish_audits(m: &mut Manifest, first_line: usize) -> Result<(), BuildError> {
    if m.audits.is_empty() {
        return Ok(());
    }
    let Some(log) = &m.audit_log else {
        return Err(berr(first_line, "%% orm:audit requires %% orm:audit_log"));
    };
    for audit in &m.audits {
        let table = &m.entities[&audit.entity].table;
        if *table == log.operation.table || *table == log.change.table {
            return Err(berr(first_line, format!("%% orm:audit: the audit log table {table} cannot be audited")));
        }
    }
    m.audits.sort_by(|a, b| a.entity.cmp(&b.entity));
    Ok(())
}

fn table_json(t: &AuditTable) -> J {
    Obj::new().str("table", &t.table).strs("columns", &t.columns).done()
}

pub(super) fn audit_log_json(l: &AuditLog) -> J {
    Obj::new().put("operation", table_json(&l.operation)).str("context", &l.context).put("change", table_json(&l.change)).done()
}

pub(super) fn audit_json(a: &Audit) -> J {
    let mut o = Obj::new().str("entity", &a.entity).str("mode", &a.mode).str_omit("service", &a.service);
    if !a.redact.is_empty() {
        o = o.put("redact", J::Arr(a.redact.iter().map(|p| json::strs(p)).collect()));
    }
    o.done()
}

/// Splits directive options on white space outside parentheses, so
/// `operation=core.operation(seq, operation_uuid)` stays one option.
pub fn option_fields(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut depth = 0usize;
    for ch in body.chars() {
        match ch {
            '(' => depth += 1,
            ')' if depth > 0 => depth -= 1,
            c if depth == 0 && c.is_whitespace() => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
                continue;
            }
            _ => {}
        }
        current.push(ch);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}
