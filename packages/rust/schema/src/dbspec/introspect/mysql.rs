//! Reads the MySQL catalog. Every query reads the whole current database at once.

use super::super::literal::quote;
use super::super::model::Type;
use super::super::names::rendered_column;
use super::super::render::{Dialect, UUID_PATTERN};
use super::check::decode_check;
use super::trigger::ITrigger;
use super::{action_name, group, Catalog, ICheck, IColumn, IForeignKey, IKey, ITable, Results};
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

const TABLES: usize = 0;
const COLUMNS: usize = 1;
const INDEXES: usize = 2;
const FOREIGN_KEYS: usize = 3;
const CHECK_CLAUSES: usize = 4;
const CHECKS: usize = 5;
const TRIGGERS: usize = 6;
const ROUTINES: usize = 7;
const EVENTS: usize = 8;

// Joining CHECK_CONSTRAINTS and TABLE_CONSTRAINTS slows down in proportion to the table count (at 2000 tables
// it takes over 60 seconds), so the two are read by two queries and joined by name. A MySQL CHECK name is unique within the database.
pub(super) const QUERIES: [&str; 9] = [
    "SELECT TABLE_NAME, TABLE_TYPE, IFNULL(CREATE_OPTIONS, '') FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT LIKE 'dbspec$%' ORDER BY TABLE_NAME",
    "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA,
IFNULL(CHARACTER_SET_NAME, ''), IFNULL(COLLATION_NAME, ''), IFNULL(GENERATION_EXPRESSION, '')
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME NOT LIKE 'dbspec$%' ORDER BY TABLE_NAME, ORDINAL_POSITION",
    "SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, IFNULL(COLUMN_NAME, ''), IFNULL(COLLATION, 'A'),
SUB_PART IS NOT NULL, EXPRESSION IS NOT NULL, INDEX_TYPE FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
    "SELECT rc.TABLE_NAME, rc.CONSTRAINT_NAME, rc.REFERENCED_TABLE_NAME, rc.DELETE_RULE, rc.UPDATE_RULE,
rc.MATCH_OPTION, k.COLUMN_NAME, k.REFERENCED_COLUMN_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS rc
JOIN information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND k.TABLE_NAME = rc.TABLE_NAME
WHERE rc.CONSTRAINT_SCHEMA = DATABASE() ORDER BY rc.TABLE_NAME, rc.CONSTRAINT_NAME, k.ORDINAL_POSITION",
    "SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY CONSTRAINT_NAME",
    "SELECT TABLE_NAME, CONSTRAINT_NAME, ENFORCED FROM information_schema.TABLE_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'CHECK' ORDER BY TABLE_NAME, CONSTRAINT_NAME",
    "SELECT EVENT_OBJECT_TABLE, TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT
FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME",
    "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY ROUTINE_NAME",
    "SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() ORDER BY EVENT_NAME",
];

static TYPE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(smallint|int|bigint|tinyint\(1\)|double|longtext|longblob|date|char\(36\)|time|datetime)(?:\((\d+)\))?$|^(decimal)\((\d+),(\d+)\)$|^(varchar)\((\d+)\)$")
        .expect("MySQL type pattern")
});

pub(super) fn read(results: &Results) -> Result<Catalog, String> {
    let mut c = Catalog::default();
    for row in results.rows(TABLES) {
        let (name, kind, options) = (row.text(0)?, row.text(1)?, row.text(2)?);
        if kind != "BASE TABLE" {
            c.report("view", &name, &name, format!("a {} has no dbspec definition", kind.to_lowercase()));
            continue;
        }
        if options.contains("partitioned") {
            c.report("partition", &name, &name, "a partitioned table has no dbspec definition");
            continue;
        }
        c.tables.push(ITable::new(&name));
    }
    // table: column: type. Used when comparing renderer CHECKs.
    let mut columns: BTreeMap<String, BTreeMap<String, Type>> = BTreeMap::new();
    // table: column: the catalog type of a type that is determined only when a renderer CHECK exists.
    let mut pending: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for row in results.rows(COLUMNS) {
        let (table, name, column_type, nullable) = (row.text(0)?, row.text(1)?, row.text(2)?, row.text(3)?);
        let dflt = row.opt_text(4)?;
        let (extra, charset, collation, generation) = (row.text(5)?, row.text(6)?, row.text(7)?, row.text(8)?);
        if !c.has_table(&table) {
            continue;
        }
        if !generation.is_empty() {
            c.report("column", &table, &name, "a generated column has no dbspec definition");
            continue;
        }
        let Some((typ, needs_check)) = mysql_type(&column_type, &charset, &collation) else {
            c.report("column", &table, &name, format!("type {column_type} {charset} {collation} has no dbspec type"));
            continue;
        };
        let mut col = IColumn { name: name.clone(), typ, null: nullable == "YES", identity: false, dflt: String::new() };
        let extra = extra.trim();
        match (extra, &dflt) {
            ("auto_increment", _) => col.identity = true,
            ("DEFAULT_GENERATED", Some(value)) => {
                if !mysql_now(value, typ) {
                    c.report("column", &table, &name, format!("default {value} is not a dbspec default"));
                    continue;
                }
                col.dflt = "now".to_owned();
            }
            ("", Some(value)) => col.dflt = mysql_default(value, typ),
            ("", None) => {}
            _ => {
                c.report("column", &table, &name, format!("extra {extra} has no dbspec definition"));
                continue;
            }
        }
        c.table(&table).expect("table read above").columns.push(col);
        columns.entry(table.clone()).or_default().insert(name.clone(), typ);
        if !needs_check.is_empty() {
            pending.entry(table).or_default().insert(name, needs_check);
        }
    }
    read_indexes(results, &mut c)?;
    read_foreign_keys(results, &mut c)?;
    let mut checked: BTreeMap<String, BTreeMap<String, bool>> = BTreeMap::new();
    let mut clauses: BTreeMap<String, String> = BTreeMap::new();
    for row in results.rows(CHECK_CLAUSES) {
        clauses.insert(row.text(0)?, row.text(1)?);
    }
    // The follow-up rows are the SHOW CREATE TABLE of each table that needs them.
    let mut shown: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for index in QUERIES.len()..results.count() {
        for row in results.rows(index) {
            shown.insert(row.text(0)?, shown_checks(&row.text(1)?));
        }
    }
    for row in results.rows(CHECKS) {
        let (table, name, enforced) = (row.text(0)?, row.text(1)?, row.text(2)?);
        let stored = clauses.get(&name).cloned().ok_or_else(|| format!("check {table}.{name} has no CHECK_CLAUSE"))?;
        let clause = if stored.is_ascii() {
            stored
        } else {
            shown.get(&table).and_then(|checks| checks.get(&name)).cloned().ok_or_else(|| format!("check {table}.{name} has no CHECK in SHOW CREATE TABLE"))?
        };
        let Some(types) = c.table(&table).map(|t| t.types()) else { continue };
        if enforced != "YES" {
            c.report("check", &table, &name, "the check is not enforced");
            continue;
        }
        if name.contains('$') {
            let found = columns.get(&table).and_then(|cols| {
                let column = rendered_column(&table, &name, cols.keys().map(String::as_str))?;
                Some((column, cols[column]))
            });
            let Some((column, _)) = found.filter(|&(column, typ)| without_introducers(&clause) == without_introducers(&renderer_check(column, typ))) else {
                c.report("check", &table, &name, format!("the check {clause} is not the renderer CHECK"));
                continue;
            };
            checked.entry(table.clone()).or_default().insert(column.to_owned(), true);
            continue;
        }
        match decode_check(Dialect::MySql, &clause, &types) {
            Ok(predicate) => c.table(&table).expect("table read above").checks.push(ICheck { name, predicate }),
            Err(e) => c.report("check", &table, &name, e),
        }
    }
    // A type that needs a renderer CHECK is not a dbspec type without that CHECK.
    for (table, cols) in &pending {
        for (column, need) in cols {
            if !checked.get(table).is_some_and(|c| c.contains_key(column)) {
                c.report("column", table, column, format!("{need} without its renderer CHECK has no dbspec type"));
                c.drop_column(table, column);
            }
        }
    }
    read_triggers(results, &mut c)?;
    for (kind, query) in [("routine", ROUTINES), ("event", EVENTS)] {
        for row in results.rows(query) {
            let name = row.text(0)?;
            c.report(kind, "", &name, format!("a {kind} has no dbspec definition"));
        }
    }
    Ok(c)
}

/// Reads COLUMN_TYPE, character set, and collation as a dbspec type. The second value
/// is the catalog type for the case where the type exists only with a renderer CHECK; otherwise it is an empty
/// string.
fn mysql_type(column_type: &str, charset: &str, collation: &str) -> Option<(Type, String)> {
    let m = TYPE_PATTERN.captures(column_type)?;
    let text = charset == "utf8mb4" && collation == "utf8mb4_0900_bin";
    let plain = |typ: Type, ok: bool| ok.then_some((typ, String::new()));
    if group(&m, 3) == "decimal" {
        let p = group(&m, 4).parse().ok()?;
        let s = group(&m, 5).parse().ok()?;
        return plain(Type::Decimal(p, s), charset.is_empty());
    }
    if group(&m, 6) == "varchar" {
        return plain(Type::Varchar(group(&m, 7).parse().ok()?), text);
    }
    let width = group(&m, 2);
    let precision = || if width.is_empty() { Some(0) } else { width.parse().ok() };
    match group(&m, 1) {
        "smallint" => plain(Type::I16, width.is_empty()),
        "int" => plain(Type::I32, width.is_empty()),
        "bigint" => plain(Type::I64, width.is_empty()),
        "tinyint(1)" => Some((Type::Bool, column_type.to_owned())),
        "double" => plain(Type::F64, width.is_empty()),
        "longtext" => plain(Type::Text, text),
        "longblob" => plain(Type::Bytes, true),
        "char(36)" => (charset == "ascii" && collation == "ascii_bin").then(|| (Type::Uuid, column_type.to_owned())),
        "date" => plain(Type::Date, width.is_empty()),
        "time" => Some((Type::Time(precision()?), column_type.to_owned())),
        "datetime" => plain(Type::DateTime(precision()?), true),
        _ => None,
    }
}

static INTRODUCER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"_[a-z0-9]+\\'").expect("MySQL introducer pattern"));
static TIME_FRACTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\'(\d\d:\d\d:\d\d)\.0+\\'").expect("MySQL time fraction pattern"));

/// The `SHOW CREATE TABLE` of each table with a CHECK whose CHECK_CLAUSE holds
/// non-ASCII text (MySQL 8.4.11 writes such a clause with its UTF-8 bytes
/// encoded a second time, so `café` reads as `cafÃ©`; SHOW CREATE TABLE writes
/// the literal correctly). Table names come from the first results: the rows of
/// the CHECK_CLAUSES and CHECKS queries.
pub(super) fn followups(results: &Results) -> Result<Vec<String>, String> {
    let mut clauses: BTreeMap<String, String> = BTreeMap::new();
    for row in results.rows(CHECK_CLAUSES) {
        clauses.insert(row.text(0)?, row.text(1)?);
    }
    let mut tables: BTreeSet<String> = BTreeSet::new();
    for row in results.rows(CHECKS) {
        let (table, name) = (row.text(0)?, row.text(1)?);
        if clauses.get(&name).is_some_and(|clause| !clause.is_ascii()) {
            tables.insert(table);
        }
    }
    Ok(tables.iter().map(|table| format!("SHOW CREATE TABLE `{}`", table.replace('`', "``"))).collect())
}

/// The CHECK bodies of a `SHOW CREATE TABLE` statement by constraint name, in
/// CHECK_CLAUSE form: the body is escaped once more, which the reader of a
/// CHECK_CLAUSE undoes (`unescape_mysql_clause` of check.rs).
fn shown_checks(create: &str) -> BTreeMap<String, String> {
    let mut checks = BTreeMap::new();
    let mut rest = create;
    while let Some(at) = rest.find("CONSTRAINT `") {
        let after = &rest[at + "CONSTRAINT `".len()..];
        let Some(close) = after.find("` CHECK (") else { break };
        if let Some(body) = check_body(&after[close + "` CHECK (".len()..]) {
            checks.insert(after[..close].to_owned(), body.replace('\\', "\\\\").replace('\'', "\\'"));
        }
        rest = after;
    }
    checks
}

/// The text up to the `)` that closes the `CHECK (` before `text`. A string
/// literal of SHOW CREATE TABLE escapes `\` and `'` with a backslash.
fn check_body(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut depth = 1usize;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' => {
                i += 1;
                while i < bytes.len() && bytes[i] != b'\'' {
                    i += if bytes[i] == b'\\' { 2 } else { 1 };
                }
            }
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[..i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// CHECK_CLAUSE without the character set introducer. ALTER TABLE rewrites CHECK_CLAUSE
/// and changes or removes introducers (probe mysql.check.alter_rewrites_introducers),
/// so renderer CHECKs are compared without introducers. The literals of this template are ASCII, so
/// the meaning is the same.
fn without_introducers(clause: &str) -> String {
    // ALTER TABLE also attaches a fractional part of p zeros to a time literal that meets a time(p) column,
    // (probe mysql.check.alter_writes_time_precision), so that fraction is removed too.
    let clause = INTRODUCER.replace_all(clause, r"\'");
    TIME_FRACTION.replace_all(&clause, r"\'${1}\'").into_owned()
}

/// The form in which a renderer CHECK remains in CHECK_CLAUSE (docs/dialects.md "Introspection",
/// "Checks"). A type without a renderer CHECK is an empty string.
fn renderer_check(column: &str, typ: Type) -> String {
    let c = format!("`{column}`");
    match typ {
        Type::Bool => format!("({c} in (0,1))"),
        Type::Uuid => format!("regexp_like({c},_utf8mb4\\'{UUID_PATTERN}\\',_utf8mb4\\'c\\')"),
        Type::Time(_) => format!("(({c} >= _utf8mb4\\'00:00:00\\') and ({c} < _utf8mb4\\'24:00:00\\'))"),
        _ => String::new(),
    }
}

/// Tells whether a DEFAULT_GENERATED default is the renderer's time default of that column.
fn mysql_now(text: &str, typ: Type) -> bool {
    match typ {
        Type::DateTime(0) => text == "CURRENT_TIMESTAMP",
        Type::DateTime(p) => text == format!("CURRENT_TIMESTAMP({p})"),
        _ => false,
    }
}

/// Writes the COLUMN_DEFAULT value with its escapes undone as a dbspec literal. parse decides its canonical form and
/// validity.
fn mysql_default(value: &str, typ: Type) -> String {
    match typ {
        Type::Bool if value == "1" => "true".to_owned(),
        Type::Bool if value == "0" => "false".to_owned(),
        Type::I16 | Type::I32 | Type::I64 | Type::Decimal(..) | Type::F64 => value.to_owned(),
        _ => quote(value),
    }
}

struct IndexRow {
    table: String,
    name: String,
    column: String,
    collation: String,
    unique: bool,
    part: bool,
    expression: bool,
    kind: String,
}

fn read_indexes(results: &Results, c: &mut Catalog) -> Result<(), String> {
    let mut rows = Vec::new();
    for row in results.rows(INDEXES) {
        rows.push(IndexRow {
            table: row.text(0)?,
            name: row.text(1)?,
            unique: row.int(2)? == 0,
            column: row.text(3)?,
            collation: row.text(4)?,
            part: row.flag(5)?,
            expression: row.flag(6)?,
            kind: row.text(7)?,
        });
    }
    let mut i = 0;
    while i < rows.len() {
        let mut j = i;
        while j < rows.len() && rows[j].table == rows[i].table && rows[j].name == rows[i].name {
            j += 1;
        }
        let group = &rows[i..j];
        i = j;
        let first = &group[0];
        if !c.has_table(&first.table) {
            continue;
        }
        let mut key = IKey { name: first.name.clone(), columns: Vec::new(), desc: Vec::new() };
        let mut supported = first.kind == "BTREE";
        for x in group {
            if x.part || x.expression || x.column.is_empty() {
                supported = false;
            }
            key.columns.push(x.column.clone());
            key.desc.push(x.collation == "D");
        }
        let table = first.table.as_str();
        if !supported {
            c.report("index", table, &key.name, format!("a prefix, expression or {} index has no dbspec definition", first.kind.to_lowercase()));
        } else if key.name == "PRIMARY" {
            c.table(table).expect("table read above").primary = key.columns;
        } else if key.name.contains('$') {
            c.report("index", table, &key.name, "the name contains $");
        } else if first.unique {
            c.table(table).expect("table read above").uniques.push(key);
        } else {
            c.table(table).expect("table read above").indexes.push(key);
        }
    }
    Ok(())
}

fn read_foreign_keys(results: &Results, c: &mut Catalog) -> Result<(), String> {
    // The foreign key being read and its table. When a row of another key comes, it is added to the table.
    let mut current: Option<(String, IForeignKey)> = None;
    // Skips the remaining column rows of a key already reported.
    let mut skipped: Option<(String, String)> = None;
    for row in results.rows(FOREIGN_KEYS) {
        let (table, name, ref_table, on_delete, on_update) = (row.text(0)?, row.text(1)?, row.text(2)?, row.text(3)?, row.text(4)?);
        let (match_option, column, ref_column) = (row.text(5)?, row.text(6)?, row.text(7)?);
        if current.as_ref().is_some_and(|(t, f)| f.name != name || *t != table) {
            flush(c, current.take());
        }
        if skipped.as_ref().is_some_and(|(t, n)| *t == table && *n == name) {
            continue;
        }
        skipped = None;
        if current.is_none() {
            if !c.has_table(&table) {
                continue;
            }
            let (Some(del), Some(upd), "NONE") = (action_name(&on_delete), action_name(&on_update), match_option.as_str()) else {
                c.report("foreign_key", &table, &name, format!("actions {on_delete}, {on_update} or match {match_option} have no dbspec definition"));
                skipped = Some((table, name));
                continue;
            };
            let key = IForeignKey { name, columns: Vec::new(), table: ref_table, refs: Vec::new(), on_delete: del, on_update: upd };
            current = Some((table, key));
        }
        let (_, key) = current.as_mut().expect("current foreign key");
        key.columns.push(column);
        key.refs.push(ref_column);
    }
    flush(c, current);
    Ok(())
}

fn flush(c: &mut Catalog, current: Option<(String, IForeignKey)>) {
    if let Some((table, key)) = current {
        c.table(&table).expect("table read above").fks.push(key);
    }
}

/// Rewrites a trigger in the renderer statement form and recognizes it.
fn read_triggers(results: &Results, c: &mut Catalog) -> Result<(), String> {
    let mut triggers: BTreeMap<String, Vec<ITrigger>> = BTreeMap::new();
    for row in results.rows(TRIGGERS) {
        let (table, name, timing, event, statement) = (row.text(0)?, row.text(1)?, row.text(2)?, row.text(3)?, row.text(4)?);
        let statements = vec![format!("CREATE TRIGGER `{name}` {timing} {event} ON `{table}` FOR EACH ROW {statement}")];
        triggers.entry(table).or_default().push(ITrigger { name, statements });
    }
    c.recognize_triggers(Dialect::MySql, triggers);
    Ok(())
}

#[cfg(test)]
mod show_create_tests {
    use super::shown_checks;
    use std::time::Duration;

    /// Every case of tests/dbspec/show-create.json reads to its expected body, or to no body for a name the statement lacks (T62-4-8).
    #[test]
    fn every_show_create_case_reads_to_its_expected_body() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::wall_for_cpu(Duration::from_secs(10)));
        let data: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../../tests/dbspec/show-create.json")).expect("tests/dbspec/show-create.json is valid JSON");
        let cases = data["cases"].as_array().expect("cases is an array");
        assert!(!cases.is_empty(), "tests/dbspec/show-create.json has no cases");
        for case in cases {
            let id = case["id"].as_str().expect("case id is a string");
            let lines: Vec<&str> =
                case["create"].as_array().expect("create is an array").iter().map(|line| line.as_str().expect("create line is a string")).collect();
            let name = case["name"].as_str().expect("case name is a string");
            let expected = case["expected"].as_str().expect("expected is a string");
            let create = format!("{}\n", lines.join("\n"));
            let got = shown_checks(&create).get(name).cloned().unwrap_or_else(|| "not found".to_owned());
            assert_eq!(got, expected, "case {id}: the reader of check {name}");
        }
    }
}
