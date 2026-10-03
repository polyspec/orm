//! SQLite catalog를 읽는다. sqlite_master와 table-valued pragma를 join해 모든
//! table을 한 번에 읽는다.

use super::super::model::{Column, Name, Type};
use super::super::render::{Dialect, Renderer};
use super::check::{decode_check, unscaled_decimal};
use super::trigger::ITrigger;
use super::{action_name, group, renderer_check_name, Catalog, ICheck, IColumn, IForeignKey, IKey, ITable, Results, Unsupported};
use regex::Regex;
use std::collections::BTreeMap;
use std::sync::LazyLock;

const MASTER: usize = 0;
const COLUMNS: usize = 1;
const INDEXES: usize = 2;

pub(super) const QUERIES: [&str; 3] = [
    "SELECT type, name, tbl_name, IFNULL(sql, '') FROM sqlite_master
WHERE name NOT LIKE 'sqlite_%' AND tbl_name NOT LIKE 'dbspec$%' ORDER BY type, name",
    "SELECT m.name, p.name, p.type, p.\"notnull\", p.dflt_value, p.pk, p.hidden FROM sqlite_master m
JOIN pragma_table_xinfo(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND p.name NOT LIKE 'dbspec$%' ORDER BY m.name, p.cid",
    "SELECT m.name, l.name, l.\"unique\", l.origin, l.partial,
IFNULL((SELECT group_concat(IFNULL(x.name, ''), ',') FROM (SELECT name FROM pragma_index_xinfo(l.name) WHERE key = 1 ORDER BY seqno) x), ''),
IFNULL((SELECT group_concat(x.\"desc\", ',') FROM (SELECT \"desc\" FROM pragma_index_xinfo(l.name) WHERE key = 1 ORDER BY seqno) x), '')
FROM sqlite_master m JOIN pragma_index_list(m.name) l WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, l.name",
];

static DECLARED_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(smallint|integer|bigint|BOOLEAN|REAL|TEXT|BLOB|DATE|TIME|DATETIME|INTEGER)$|^DECIMALINT\((\d+),(\d+)\)$|^varchar\((\d+)\)$")
        .expect("SQLite declared type pattern")
});
static FOREIGN_KEY_ITEM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^CONSTRAINT "([^"]+)" FOREIGN KEY \(([^)]*)\) REFERENCES "([^"]+)" \(([^)]*)\) ON DELETE (RESTRICT|CASCADE|SET NULL) ON UPDATE (RESTRICT|CASCADE|SET NULL)$"#)
        .expect("SQLite foreign key pattern")
});
static CHECK_ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^CONSTRAINT "([^"]+)" CHECK \((.*)\)$"#).expect("SQLite check pattern"));
static PRIMARY_KEY_ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^PRIMARY KEY \(([^)]*)\)$").expect("SQLite primary key pattern"));
static IDENTITY_COLUMN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^"([^"]+)" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT$"#).expect("SQLite identity pattern"));
static COLUMN_ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^"([^"]+)" "#).expect("SQLite column pattern"));
static CONSTRAINT_ITEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^(?:CONSTRAINT "([^"]+)" )?(CHECK|UNIQUE|FOREIGN KEY|PRIMARY KEY)\b"#).expect("SQLite constraint pattern"));
static NUMBER_DEFAULT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-?\d+(\.\d+)?$").expect("SQLite number pattern"));

/// CREATE TABLE text에서 읽은 constraint.
#[derive(Default)]
struct SqliteTable {
    /// check 이름: 식.
    checks: BTreeMap<String, String>,
    /// check 이름의 선언 순서.
    order: Vec<String>,
    fks: Vec<IForeignKey>,
    primary: Vec<String>,
    identity: String,
    /// column 이름: 정의 text.
    columns: BTreeMap<String, String>,
    /// 비어 있지 않으면 table 전체를 읽지 못한 이유다.
    unsupported: String,
}

pub(super) fn read(results: &Results) -> Result<Catalog, String> {
    let mut c = Catalog::default();
    let mut parsed: BTreeMap<String, SqliteTable> = BTreeMap::new();
    let mut triggers: BTreeMap<String, Vec<ITrigger>> = BTreeMap::new();
    for row in results.rows(MASTER) {
        let (kind, name, table, text) = (row.text(0)?, row.text(1)?, row.text(2)?, row.text(3)?);
        match kind.as_str() {
            "table" => {
                if text.starts_with("CREATE VIRTUAL TABLE") || text.ends_with("WITHOUT ROWID") {
                    c.report("table", &name, &name, "a virtual or WITHOUT ROWID table has no dbspec definition");
                    continue;
                }
                let (st, unsupported) = parse_table(&text);
                if !st.unsupported.is_empty() {
                    c.report("table", &name, &name, st.unsupported);
                    continue;
                }
                for u in unsupported {
                    c.report(&u.kind, &name, &u.name, u.reason);
                }
                let mut t = ITable::new(&name);
                t.primary = st.primary.clone();
                t.fks = st.fks.clone();
                c.tables.push(t);
                parsed.insert(name, st);
            }
            "view" => c.report("view", &name, &name, "a view has no dbspec definition"),
            "trigger" => triggers.entry(table).or_default().push(ITrigger { name, statements: vec![text] }),
            _ => {}
        }
    }
    let r = Renderer { d: Dialect::Sqlite };
    for row in results.rows(COLUMNS) {
        let (table, name, declared, not_null) = (row.text(0)?, row.text(1)?, row.text(2)?, row.int(3)?);
        let dflt = row.opt_text(4)?;
        let (_pk, hidden) = (row.int(5)?, row.int(6)?);
        if !c.has_table(&table) {
            continue;
        }
        let st = parsed.get_mut(&table).expect("table parsed above");
        if hidden != 0 {
            c.report("column", &table, &name, "a generated column has no dbspec definition");
            continue;
        }
        let item = st.columns.get(&name).cloned().unwrap_or_default();
        if st.identity != name && !column_text(&item, &name, &declared, not_null != 0, dflt.as_deref()) {
            c.report("column", &table, &name, format!("the column definition {item:?} has clauses that dbspec does not read"));
            continue;
        }
        let check_name = renderer_check_name(&table, &name);
        let check = st.checks.get(&check_name).cloned();
        let mut col = IColumn { name: name.clone(), typ: Type::I64, null: not_null == 0, identity: false, dflt: String::new() };
        if st.identity == name {
            col.identity = true;
        } else {
            let Some(typ) = sqlite_type(&r, &declared, &name, check.as_deref()) else {
                c.report("column", &table, &name, format!("declared type {declared} with CHECK {:?} has no dbspec type", check.unwrap_or_default()));
                continue;
            };
            col.typ = typ;
        }
        st.checks.remove(&check_name);
        if let Some(text) = dflt {
            let Some(value) = sqlite_default(&r, &text, col.typ) else {
                c.report("column", &table, &name, format!("default {text} is not a dbspec default"));
                continue;
            };
            col.dflt = value;
        }
        c.table(&table).expect("table read above").columns.push(col);
    }
    for i in 0..c.tables.len() {
        let table = c.tables[i].name.clone();
        let st = &parsed[&table];
        for name in &st.order {
            let Some(expression) = st.checks.get(name) else { continue };
            if name.contains('$') {
                c.report("check", &table, name, format!("the check {expression} is not the renderer CHECK"));
                continue;
            }
            match decode_check(Dialect::Sqlite, expression, &c.tables[i].types()) {
                Ok(predicate) => c.tables[i].checks.push(ICheck { name: name.clone(), predicate }),
                Err(e) => c.report("check", &table, name, e),
            }
        }
    }
    for row in results.rows(INDEXES) {
        let (table, name, unique, origin, partial, columns, desc) =
            (row.text(0)?, row.text(1)?, row.int(2)?, row.text(3)?, row.int(4)?, row.text(5)?, row.text(6)?);
        // pk와 u origin index는 primary key와 unique 정의에서 나오며, 그 정의를 읽거나 보고한다.
        if !c.has_table(&table) || origin == "pk" || origin == "u" {
            continue;
        }
        let list: Vec<String> = columns.split(',').map(str::to_owned).collect();
        if origin != "c" || partial != 0 || name.contains('$') || list.iter().any(String::is_empty) {
            c.report("index", &table, &name, format!("an index of origin {origin}, a partial or an expression index has no dbspec definition"));
            continue;
        }
        let key = IKey { name, columns: list, desc: desc.split(',').map(|d| d == "1").collect() };
        let t = c.table(&table).expect("table read above");
        if unique != 0 {
            t.uniques.push(key);
        } else {
            t.indexes.push(key);
        }
    }
    c.recognize_triggers(Dialect::Sqlite, triggers);
    Ok(c)
}

/// 선언 type과 그 column의 renderer CHECK로 dbspec type을 정한다. CHECK은 그
/// type의 renderer 출력과 정확히 같아야 한다.
fn sqlite_type(r: &Renderer, declared: &str, column: &str, check: Option<&str>) -> Option<Type> {
    let m = DECLARED_PATTERN.captures(declared)?;
    let candidates: Vec<Type> = if !group(&m, 2).is_empty() {
        vec![Type::Decimal(group(&m, 2).parse().ok()?, group(&m, 3).parse().ok()?)]
    } else if !group(&m, 4).is_empty() {
        vec![Type::Varchar(group(&m, 4).parse().ok()?)]
    } else {
        match group(&m, 1) {
            "smallint" => vec![Type::I16],
            // SQLite는 keyword인 integer를 INTEGER로 보고한다. identity는 CREATE text가 정한다.
            "integer" | "INTEGER" => vec![Type::I32],
            "bigint" => vec![Type::I64],
            "BOOLEAN" => vec![Type::Bool],
            "REAL" => vec![Type::F64],
            "TEXT" => vec![Type::Text, Type::Uuid],
            "BLOB" => vec![Type::Bytes],
            "DATE" => vec![Type::Date],
            "TIME" => (0..=6).map(Type::Time).collect(),
            "DATETIME" => (0..=6).map(Type::DateTime).collect(),
            _ => Vec::new(),
        }
    };
    candidates.into_iter().find(|typ| {
        let want = r.type_check(&Column {
            comments: Vec::new(),
            name: Name { text: column.to_owned(), pos: Default::default() },
            ty: *typ,
            nullable: false,
            identity: None,
            default: None,
        });
        want.as_deref() == check
    })
}

/// dflt_value를 dbspec literal이나 now로 읽는다. decimal은 scale을 곱한 정수이고
/// bool은 1과 0이다.
fn sqlite_default(r: &Renderer, text: &str, typ: Type) -> Option<String> {
    if let Type::DateTime(p) = typ {
        if format!("({text})") == r.now(p) {
            return Some("now".to_owned());
        }
    }
    if typ == Type::Bool && (text == "1" || text == "0") {
        return Some(if text == "1" { "true" } else { "false" }.to_owned());
    }
    if NUMBER_DEFAULT.is_match(text) {
        if let Type::Decimal(_, scale) = typ {
            return Some(unscaled_decimal(text, usize::from(scale)));
        }
        return Some(text.to_owned());
    }
    (text.starts_with('\'') && text.ends_with('\'')).then(|| text.to_owned())
}

/// renderer가 쓰는 한 줄 CREATE TABLE text에서 primary key, identity, foreign
/// key, check를 읽는다. 그 밖의 table 수준 항목은 미지원이다.
fn parse_table(text: &str) -> (SqliteTable, Vec<Unsupported>) {
    let mut st = SqliteTable::default();
    let mut unsupported = Vec::new();
    let (Some(open), true) = (text.find('('), text.ends_with(')')) else {
        st.unsupported = "the CREATE TABLE text has no column list".to_owned();
        return (st, Vec::new());
    };
    for item in split_top_level(&text[open + 1..text.len() - 1]) {
        if let Some(m) = IDENTITY_COLUMN.captures(item) {
            st.identity = group(&m, 1).to_owned();
            st.primary = vec![st.identity.clone()];
        } else if let Some(m) = PRIMARY_KEY_ITEM.captures(item) {
            st.primary = unquote_list(group(&m, 1));
        } else if let Some(m) = FOREIGN_KEY_ITEM.captures(item) {
            st.fks.push(IForeignKey {
                name: group(&m, 1).to_owned(),
                columns: unquote_list(group(&m, 2)),
                table: group(&m, 3).to_owned(),
                refs: unquote_list(group(&m, 4)),
                on_delete: action_name(group(&m, 5)).expect("pattern admits only dbspec actions"),
                on_update: action_name(group(&m, 6)).expect("pattern admits only dbspec actions"),
            });
        } else if let Some(m) = CHECK_ITEM.captures(item) {
            st.checks.insert(group(&m, 1).to_owned(), group(&m, 2).to_owned());
            st.order.push(group(&m, 1).to_owned());
        } else if let Some(m) = CONSTRAINT_ITEM.captures(item) {
            // 이름 없는 constraint는 이름이 빈 객체로 보고한다. primary key의 다른 형식은 table을 읽지 못하게 한다.
            let kind = match group(&m, 2) {
                "CHECK" => "check",
                "UNIQUE" => "unique",
                "FOREIGN KEY" => "foreign_key",
                _ => {
                    st.unsupported = format!("the primary key {item:?} has no dbspec definition");
                    return (st, Vec::new());
                }
            };
            let name = m.get(1).map_or("", |g| g.as_str()).to_owned();
            let reason = format!("the table item {item:?} has no dbspec definition");
            unsupported.push(Unsupported { kind: kind.to_owned(), table: String::new(), name, reason });
        } else if let Some(m) = COLUMN_ITEM.captures(item) {
            // 정의는 pragma_table_xinfo가 읽고, 그 text는 renderer 형식인지 확인한다.
            st.columns.insert(group(&m, 1).to_owned(), item.to_owned());
        } else {
            st.unsupported = format!("the table item {item:?} has no dbspec definition");
            return (st, Vec::new());
        }
    }
    (st, unsupported)
}

/// column 정의 text가 renderer의 column 형식, 곧 이름, 선언 type, NULL이나 NOT
/// NULL, 그리고 있으면 DEFAULT뿐인지 알려 준다. SQLite는 keyword인 type 이름을
/// 대문자로 보고하므로 type은 대소문자 없이 비교한다.
fn column_text(item: &str, name: &str, declared: &str, not_null: bool, dflt: Option<&str>) -> bool {
    let Some(rest) = item.strip_prefix(&format!("\"{name}\" ")) else { return false };
    let Some(head) = rest.get(..declared.len()) else { return false };
    if !head.eq_ignore_ascii_case(declared) {
        return false;
    }
    let rest = &rest[declared.len()..];
    let tail = if not_null { " NOT NULL" } else { " NULL" };
    match dflt {
        None => rest == tail,
        Some(d) => rest == format!("{tail} DEFAULT {d}") || rest == format!("{tail} DEFAULT ({d})"),
    }
}

/// 괄호와 따옴표 밖의 쉼표로 나눈다.
fn split_top_level(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let (mut depth, mut start) = (0i32, 0);
    let mut quote = 0u8;
    for (i, &ch) in bytes.iter().enumerate() {
        if quote != 0 {
            if ch == quote {
                quote = 0;
            }
        } else if ch == b'\'' || ch == b'"' {
            quote = ch;
        } else if ch == b'(' {
            depth += 1;
        } else if ch == b')' {
            depth -= 1;
        } else if ch == b',' && depth == 0 {
            out.push(text[start..i].trim());
            start = i + 1;
        }
    }
    out.push(text[start..].trim());
    out
}

fn unquote_list(text: &str) -> Vec<String> {
    text.split(',').map(|part| part.trim().trim_matches('"').to_owned()).collect()
}
