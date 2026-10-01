//! MySQL catalog를 읽는다. 모든 query는 현재 database 전체를 한 번에 읽는다.

use super::super::literal::quote;
use super::super::model::Type;
use super::super::render::{Dialect, UUID_PATTERN};
use super::check::decode_check;
use super::trigger::ITrigger;
use super::{action_name, group, Catalog, ICheck, IColumn, IForeignKey, IKey, ITable, Results};
use regex::Regex;
use std::collections::BTreeMap;
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

// CHECK_CONSTRAINTS와 TABLE_CONSTRAINTS의 join은 table 수에 비례해 느려지므로(2000 table에서
// 60초 이상) 두 query로 읽고 이름으로 잇는다. MySQL의 CHECK 이름은 database 안에서 유일하다.
pub(super) const QUERIES: [&str; 9] = [
    "SELECT TABLE_NAME, TABLE_TYPE, IFNULL(CREATE_OPTIONS, '') FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME",
    "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA,
IFNULL(CHARACTER_SET_NAME, ''), IFNULL(COLLATION_NAME, ''), IFNULL(GENERATION_EXPRESSION, '')
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION",
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
    // table: column: type. renderer CHECK을 비교할 때 쓴다.
    let mut columns: BTreeMap<String, BTreeMap<String, Type>> = BTreeMap::new();
    // table: column: renderer CHECK이 있어야 정해지는 type의 catalog type.
    let mut pending: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for row in results.rows(COLUMNS) {
        let (table, name, column_type, nullable) = (row.text(0)?, row.text(1)?, row.text(2)?, row.text(3)?);
        let dflt = row.opt_text(4)?;
        let (extra, charset, collation, generation) = (row.text(5)?, row.text(6)?, row.text(7)?, row.text(8)?);
        if !c.has_table(&table) {
            continue;
        }
        let Some((typ, needs_check)) = mysql_type(&column_type, &charset, &collation).filter(|_| generation.is_empty()) else {
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
    for row in results.rows(CHECKS) {
        let (table, name, enforced) = (row.text(0)?, row.text(1)?, row.text(2)?);
        let clause = clauses.get(&name).cloned().ok_or_else(|| format!("check {table}.{name} has no CHECK_CLAUSE"))?;
        let Some(types) = c.table(&table).map(|t| t.types()) else { continue };
        if enforced != "YES" {
            c.report("check", &table, &name, "the check is not enforced");
            continue;
        }
        if let Some((owner, column)) = name.split_once('$') {
            let known = columns.get(&table).and_then(|cols| cols.get(column));
            if owner != table || known.is_none_or(|typ| without_introducers(&clause) != without_introducers(&renderer_check(column, *typ))) {
                c.report("check", &table, &name, format!("the check {clause} is not the renderer CHECK"));
                continue;
            }
            checked.entry(table.clone()).or_default().insert(column.to_owned(), true);
            continue;
        }
        match decode_check(Dialect::MySql, &clause, &types) {
            Ok(predicate) => c.table(&table).expect("table read above").checks.push(ICheck { name, predicate }),
            Err(e) => c.report("check", &table, &name, e),
        }
    }
    // renderer CHECK이 있어야 하는 type은 그 CHECK이 없으면 dbspec type이 아니다.
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

/// COLUMN_TYPE과 character set, collation을 dbspec type으로 읽는다. 둘째 값은
/// renderer CHECK이 있어야 그 type이 되는 경우의 catalog type이고, 아니면 빈
/// 문자열이다.
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

/// character set introducer를 뺀 CHECK_CLAUSE다. ALTER TABLE은 CHECK_CLAUSE를 다시
/// 쓰며 introducer를 바꾸거나 빼므로(probe mysql.check.alter_rewrites_introducers)
/// renderer CHECK은 introducer 없이 비교한다. 이 template의 literal은 ASCII이므로
/// 의미가 같다.
fn without_introducers(clause: &str) -> String {
    INTRODUCER.replace_all(clause, r"\'").into_owned()
}

/// renderer CHECK이 CHECK_CLAUSE에 남는 형식 (docs/dialects.md "Introspection",
/// "Checks"). renderer CHECK이 없는 type은 빈 문자열이다.
fn renderer_check(column: &str, typ: Type) -> String {
    let c = format!("`{column}`");
    match typ {
        Type::Bool => format!("({c} in (0,1))"),
        Type::Uuid => format!("regexp_like({c},_utf8mb4\\'{UUID_PATTERN}\\',_utf8mb4\\'c\\')"),
        Type::Time(_) => format!("(({c} >= _utf8mb4\\'00:00:00\\') and ({c} < _utf8mb4\\'24:00:00\\'))"),
        _ => String::new(),
    }
}

/// DEFAULT_GENERATED default가 그 column의 renderer 시각 default인지 알려 준다.
fn mysql_now(text: &str, typ: Type) -> bool {
    match typ {
        Type::DateTime(0) => text == "CURRENT_TIMESTAMP",
        Type::DateTime(p) => text == format!("CURRENT_TIMESTAMP({p})"),
        _ => false,
    }
}

/// escape를 푼 COLUMN_DEFAULT 값을 dbspec literal로 쓴다. parse가 canonical form과
/// 유효성을 정한다.
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
    // 읽는 중인 foreign key와 그 table. 다른 key의 row가 오면 table에 더한다.
    let mut current: Option<(String, IForeignKey)> = None;
    // 보고한 key의 나머지 column row는 건너뛴다.
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

/// trigger를 renderer statement 형식으로 다시 쓰고 알아본다.
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
