//! PostgreSQL catalog를 읽는다. 모든 query는 현재 schema 전체를 한 번에 읽는다.

use super::super::literal::quote;
use super::super::model::Type;
use super::super::render::Dialect;
use super::check::decode_check;
use super::trigger::ITrigger;
use super::{group, Catalog, ICheck, IColumn, IForeignKey, IKey, ITable, Results};
use regex::Regex;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

const TABLES: usize = 0;
const SEQUENCES: usize = 1;
const COLUMNS: usize = 2;
const CONSTRAINTS: usize = 3;
const INDEXES: usize = 4;
const TRIGGERS: usize = 5;
const ROUTINES: usize = 6;

pub(super) const QUERIES: [&str; 7] = [
    "SELECT c.relname, c.relkind::text, c.relispartition FROM pg_class c
WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY c.relname",
    "SELECT c.relname FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'S'
AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'i') ORDER BY c.relname",
    "SELECT c.relname, a.attname, quote_ident(a.attname), format_type(a.atttypid, a.atttypmod), a.attnotnull,
pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, a.attgenerated::text, coalesce(co.collname, '')
FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN pg_collation co ON co.oid = a.attcollation
WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY c.relname, a.attnum",
    "SELECT c.relname, con.conname, con.contype::text, pg_get_constraintdef(con.oid), con.condeferrable,
con.convalidated, con.confmatchtype::text, con.confdeltype::text, con.confupdtype::text, CASE WHEN r.relnamespace = c.relnamespace THEN r.relname ELSE '' END,
array_to_string(ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o), ','),
array_to_string(ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
  JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o), ',')
FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid LEFT JOIN pg_class r ON r.oid = con.confrelid
WHERE c.relnamespace = current_schema()::regnamespace AND con.contype <> 'n' ORDER BY c.relname, con.conname",
    "SELECT c.relname, i.relname, x.indisunique, x.indpred IS NOT NULL, x.indexprs IS NOT NULL,
x.indnatts <> x.indnkeyatts, am.amname,
array_to_string(ARRAY(SELECT a.attname FROM unnest(x.indkey) WITH ORDINALITY k(n, o)
  JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.n ORDER BY k.o), ','),
array_to_string(ARRAY(SELECT (o & 1)::text FROM unnest(x.indoption::int2[]) o), ',')
FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid JOIN pg_am am ON am.oid = i.relam
WHERE c.relnamespace = current_schema()::regnamespace
AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = x.indexrelid AND con.contype IN ('p', 'u', 'x'))
ORDER BY c.relname, i.relname",
    "SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid), p.proname, p.prosrc, l.lanname
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_language l ON l.oid = p.prolang
WHERE NOT t.tgisinternal AND c.relnamespace = current_schema()::regnamespace ORDER BY c.relname, t.tgname",
    "SELECT p.proname FROM pg_proc p WHERE p.pronamespace = current_schema()::regnamespace ORDER BY p.proname",
];

static TYPE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(smallint|integer|bigint|boolean|double precision|text|bytea|uuid|date)$|^numeric\((\d+),(\d+)\)$|^character varying\((\d+)\)$|^(time|timestamp)\((\d)\) without time zone$")
        .expect("PostgreSQL type pattern")
});
static LITERAL_PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^'((?:[^']|'')*)'::([a-z ]+)$").expect("PostgreSQL literal pattern"));
static NUMBER_PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-?\d+(\.\d+)?$").expect("PostgreSQL number pattern"));
static TRIGGER_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^CREATE TRIGGER (\S+) (BEFORE|AFTER) (INSERT|UPDATE|DELETE) ON (?:\S+\.)?(\S+) FOR EACH ROW EXECUTE FUNCTION (\S+)\(\)$")
        .expect("PostgreSQL trigger pattern")
});

pub(super) fn read(results: &Results) -> Result<Catalog, String> {
    let mut c = Catalog::default();
    for row in results.rows(TABLES) {
        let (name, kind, partition) = (row.text(0)?, row.text(1)?, row.flag(2)?);
        if kind == "p" || partition {
            c.report("partition", &name, &name, "a partitioned table or a partition has no dbspec definition");
        } else if kind == "r" {
            c.tables.push(ITable::new(&name));
        } else {
            c.report("view", &name, &name, format!("a relation of kind {kind} has no dbspec definition"));
        }
    }
    for row in results.rows(SEQUENCES) {
        let name = row.text(0)?;
        c.report("sequence", "", &name, "a sequence outside identity has no dbspec definition");
    }
    // table: column: quote_ident가 쓴 column 이름.
    let mut quoted: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    // table: renderer CHECK이 있어야 하는 time column.
    let mut pending: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for row in results.rows(COLUMNS) {
        let (table, name, quoted_name, formatted, not_null) = (row.text(0)?, row.text(1)?, row.text(2)?, row.text(3)?, row.flag(4)?);
        let dflt = row.opt_text(5)?;
        let (identity, generated, collation) = (row.text(6)?, row.text(7)?, row.text(8)?);
        if !c.has_table(&table) {
            continue;
        }
        let Some(typ) = postgres_type(&formatted, &collation).filter(|_| generated.is_empty()) else {
            c.report("column", &table, &name, format!("type {formatted} with collation {collation:?} has no dbspec type"));
            continue;
        };
        let mut col = IColumn { name: name.clone(), typ, null: !not_null, identity: false, dflt: String::new() };
        match identity.as_str() {
            "d" => col.identity = true,
            "a" => {
                c.report("column", &table, &name, "an identity generated always has no dbspec definition");
                continue;
            }
            _ => {}
        }
        if let Some(text) = dflt {
            let Some(value) = postgres_default(&text, typ) else {
                c.report("column", &table, &name, format!("default {text} is not a dbspec default"));
                continue;
            };
            col.dflt = value;
        }
        c.table(&table).expect("table read above").columns.push(col);
        quoted.entry(table.clone()).or_default().insert(name.clone(), quoted_name);
        if matches!(typ, Type::Time(_)) {
            pending.entry(table).or_default().insert(name);
        }
    }
    let mut checked: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for row in results.rows(CONSTRAINTS) {
        let (table, name, kind, definition, deferrable, validated) = (row.text(0)?, row.text(1)?, row.text(2)?, row.text(3)?, row.flag(4)?, row.flag(5)?);
        let (match_type, on_delete, on_update, ref_table, columns, refs) =
            (row.text(6)?, row.text(7)?, row.text(8)?, row.text(9)?, row.text(10)?, row.text(11)?);
        let Some(types) = c.table(&table).map(|t| t.types()) else { continue };
        let list: Vec<String> = columns.split(',').map(str::to_owned).collect();
        if !validated || deferrable {
            c.report(postgres_kind(&kind), &table, &name, "a deferrable or not validated constraint has no dbspec definition");
            continue;
        }
        match kind.as_str() {
            "p" => c.table(&table).expect("table read above").primary = list,
            "u" => {
                if name.contains('$') || !definition.starts_with("UNIQUE (") {
                    c.report("unique", &table, &name, format!("the unique constraint {definition} has no dbspec definition"));
                    continue;
                }
                let desc = vec![false; list.len()];
                c.table(&table).expect("table read above").uniques.push(IKey { name, columns: list, desc });
            }
            "f" if ref_table.is_empty() => {
                // 다른 schema의 table을 가리키는 foreign key는 이 문서 밖의 table을 가리킨다.
                c.report("foreign_key", &table, &name, "the referenced table is outside the current schema");
            }
            "f" => {
                let (Some(del), Some(upd), "s") = (postgres_action(&on_delete), postgres_action(&on_update), match_type.as_str()) else {
                    c.report("foreign_key", &table, &name, format!("actions {on_delete}, {on_update} or match {match_type} have no dbspec definition"));
                    continue;
                };
                let refs = refs.split(',').map(str::to_owned).collect();
                let key = IForeignKey { name, columns: list, table: ref_table, refs, on_delete: del, on_update: upd };
                c.table(&table).expect("table read above").fks.push(key);
            }
            "c" => {
                if let Some((owner, column)) = name.split_once('$') {
                    let quoted_column = quoted.get(&table).and_then(|q| q.get(column)).map_or("", String::as_str);
                    let want = format!("CHECK (({quoted_column} < '24:00:00'::time without time zone))");
                    let is_pending = pending.get(&table).is_some_and(|p| p.contains(column));
                    if owner != table || !is_pending || definition != want {
                        c.report("check", &table, &name, format!("the check {definition} is not the renderer CHECK"));
                        continue;
                    }
                    checked.entry(table.clone()).or_default().insert(column.to_owned());
                    continue;
                }
                match decode_check(Dialect::Postgres, &definition, &types) {
                    Ok(predicate) => c.table(&table).expect("table read above").checks.push(ICheck { name, predicate }),
                    Err(e) => c.report("check", &table, &name, e),
                }
            }
            _ => c.report(postgres_kind(&kind), &table, &name, format!("a constraint of kind {kind} has no dbspec definition")),
        }
    }
    for (table, cols) in &pending {
        for column in cols {
            if !checked.get(table).is_some_and(|c| c.contains(column)) {
                c.report("column", table, column, "time without its renderer CHECK has no dbspec type");
                c.drop_column(table, column);
            }
        }
    }
    for row in results.rows(INDEXES) {
        let (table, name, unique, partial, expression, include) = (row.text(0)?, row.text(1)?, row.flag(2)?, row.flag(3)?, row.flag(4)?, row.flag(5)?);
        let (method, columns, options) = (row.text(6)?, row.text(7)?, row.text(8)?);
        if !c.has_table(&table) {
            continue;
        }
        if unique || partial || expression || include || method != "btree" || name.contains('$') {
            c.report("index", &table, &name, format!("a unique, partial, expression, covering or {method} index has no dbspec index"));
            continue;
        }
        let key = IKey { name, columns: columns.split(',').map(str::to_owned).collect(), desc: options.split(',').map(|o| o == "1").collect() };
        c.table(&table).expect("table read above").indexes.push(key);
    }
    let mut triggers: BTreeMap<String, Vec<ITrigger>> = BTreeMap::new();
    let mut functions: BTreeSet<String> = BTreeSet::new();
    for row in results.rows(TRIGGERS) {
        let (table, name, definition, function, source, language) = (row.text(0)?, row.text(1)?, row.text(2)?, row.text(3)?, row.text(4)?, row.text(5)?);
        functions.insert(function.clone());
        let statements = match TRIGGER_PATTERN.captures(&definition) {
            Some(m) if language == "plpgsql" && group(&m, 1).trim_matches('"') == name && group(&m, 5).trim_matches('"') == function => vec![
                format!("CREATE FUNCTION \"{function}\"() RETURNS trigger LANGUAGE plpgsql AS $${source}$$"),
                format!(
                    "CREATE TRIGGER \"{name}\" {} {} ON \"{}\" FOR EACH ROW EXECUTE FUNCTION \"{function}\"()",
                    group(&m, 2),
                    group(&m, 3),
                    group(&m, 4).trim_matches('"')
                ),
            ],
            _ => vec![definition],
        };
        triggers.entry(table).or_default().push(ITrigger { name, statements });
    }
    c.recognize_triggers(Dialect::Postgres, triggers);
    for row in results.rows(ROUTINES) {
        let name = row.text(0)?;
        if !functions.contains(&name) {
            c.report("routine", "", &name, "a function outside the renderer triggers has no dbspec definition");
        }
    }
    Ok(c)
}

/// format_type과 collation을 dbspec type으로 읽는다.
fn postgres_type(formatted: &str, collation: &str) -> Option<Type> {
    let m = TYPE_PATTERN.captures(formatted)?;
    if !group(&m, 2).is_empty() {
        return Some(Type::Decimal(group(&m, 2).parse().ok()?, group(&m, 3).parse().ok()?));
    }
    if !group(&m, 4).is_empty() {
        return (collation == "C").then_some(Type::Varchar(group(&m, 4).parse().ok()?));
    }
    if !group(&m, 5).is_empty() {
        let p = group(&m, 6).parse().ok()?;
        return Some(if group(&m, 5) == "time" { Type::Time(p) } else { Type::DateTime(p) });
    }
    match group(&m, 1) {
        "smallint" => Some(Type::I16),
        "integer" => Some(Type::I32),
        "bigint" => Some(Type::I64),
        "boolean" => Some(Type::Bool),
        "double precision" => Some(Type::F64),
        "text" => (collation == "C").then_some(Type::Text),
        "bytea" => Some(Type::Bytes),
        "uuid" => Some(Type::Uuid),
        "date" => Some(Type::Date),
        _ => None,
    }
}

/// pg_get_expr의 default를 dbspec literal이나 now로 읽는다.
fn postgres_default(text: &str, typ: Type) -> Option<String> {
    if text == "statement_timestamp()" {
        return matches!(typ, Type::DateTime(_)).then(|| "now".to_owned());
    }
    if let Some(m) = LITERAL_PATTERN.captures(text) {
        let value = group(&m, 1).replace("''", "'");
        return Some(match typ {
            Type::I16 | Type::I32 | Type::I64 | Type::Decimal(..) | Type::F64 => value,
            _ => quote(&value),
        });
    }
    if text == "true" || text == "false" {
        return (typ == Type::Bool).then(|| text.to_owned());
    }
    NUMBER_PATTERN.is_match(text).then(|| text.to_owned())
}

fn postgres_action(code: &str) -> Option<&'static str> {
    match code {
        "r" => Some("restrict"),
        "c" => Some("cascade"),
        "n" => Some("set_null"),
        _ => None,
    }
}

fn postgres_kind(contype: &str) -> &'static str {
    match contype {
        "p" | "u" => "unique",
        "f" => "foreign_key",
        "c" => "check",
        _ => "index",
    }
}
