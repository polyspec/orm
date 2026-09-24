//! Manifest → SQL: CREATE statements for one dialect (docs/dialects.md) and
//! the migration between two manifests.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::schema::{Check, Col, Entity, Manifest, Rel};
use crate::triggers::{diff_triggers, trigger_objects};

/// MySQL has no uuid type; clients bind uuid values as text.
pub const MYSQL_UUID: &str = "char(36)";
/// MySQL stores the ordered-json text as LONGTEXT.
pub const MYSQL_JSONTEXT: &str = "longtext";

/// The line prefix that embeds the manifest in generated SQL.
pub const SCHEMA_METADATA_PREFIX: &str = "-- orm-schema-v1 ";

/// A quoting function for identifiers.
pub type Quote<'a> = &'a dyn Fn(&str) -> String;

/// The dialects the tools render.
pub fn check_dialect(dialect: &str) -> Result<(), String> {
    match dialect {
        "mysql" | "postgres" | "sqlite" => Ok(()),
        _ => Err(format!("unknown dialect {}", crate::schema::go_quote(dialect))),
    }
}

pub(crate) fn quote_qualified(quote: &str, name: &str) -> String {
    name.split('.').map(|p| format!("{quote}{}{quote}", p.replace(quote, &format!("{quote}{quote}")))).collect::<Vec<_>>().join(".")
}

#[doc(hidden)]
pub fn ddl_table(table: &str, dialect: &str) -> String {
    if dialect == "sqlite" {
        table.replace('.', "__")
    } else {
        table.to_owned()
    }
}

pub(crate) fn ddl_base(table: &str) -> &str {
    table.rsplit('.').next().unwrap_or(table)
}

fn ddl_index_name(table: &str, index: &str, dialect: &str) -> String {
    if dialect == "sqlite" {
        format!("{}_{index}", ddl_table(table, dialect))
    } else {
        bounded_identifier(&format!("{}_{index}", ddl_base(table)), dialect)
    }
}

/// MySQL CHECK constraint names are unique within a database, while the
/// schema scopes a check name to its entity. MySQL receives the name
/// ck_<table>_<name>; other dialects keep the declared name.
fn ddl_check_name(table: &str, name: &str, dialect: &str) -> String {
    if dialect == "mysql" {
        bounded_identifier(&format!("ck_{}_{name}", ddl_base(table)), dialect)
    } else {
        name.to_owned()
    }
}

/// Keeps a name within the identifier limit of the dialect (MySQL 64,
/// PostgreSQL 63 bytes). A longer name is cut and receives a suffix with the
/// first 6 bytes of its SHA-256 digest in hex, so two long names do not
/// collide after the cut.
fn bounded_identifier(name: &str, dialect: &str) -> String {
    use sha2::{Digest, Sha256};
    let limit = match dialect {
        "mysql" => 64,
        "postgres" => 63,
        _ => return name.to_owned(),
    };
    if name.len() <= limit {
        return name.to_owned();
    }
    let digest = Sha256::digest(name.as_bytes());
    let suffix: String = std::iter::once("_".to_owned()).chain(digest[..6].iter().map(|b| format!("{b:02x}"))).collect();
    format!("{}{suffix}", String::from_utf8_lossy(&name.as_bytes()[..limit - suffix.len()]))
}

/// A CHECK expression for the dialect. MySQL rejects a CASE expression with
/// predicate branches as a CHECK definition, so MySQL receives (expr) <> 0;
/// NULL stays UNKNOWN and the CHECK accepts it.
pub fn rendered_check_expression(expr: &str, dialect: &str, quote: Quote) -> Result<String, String> {
    let rendered = quoted_check_expression(expr, quote)?;
    Ok(if dialect == "mysql" { format!("({rendered}) <> 0") } else { rendered })
}

fn ddl_schemas(m: &Manifest) -> Vec<String> {
    let mut seen = BTreeSet::new();
    for e in m.ordered() {
        let parts: Vec<&str> = e.table.split('.').collect();
        if parts.len() == 2 {
            seen.insert(parts[0].to_owned());
        }
    }
    seen.into_iter().collect()
}

pub(crate) fn sql_quote(s: &str) -> String {
    s.replace('\'', "''")
}

/// Go's isNumber: digits and dots, with an optional leading minus.
#[doc(hidden)]
pub fn is_number(s: &str) -> bool {
    !s.is_empty() && s.chars().enumerate().all(|(i, r)| r.is_ascii_digit() || r == '.' || (i == 0 && r == '-'))
}

fn join_quoted(cols: &[String], q: Quote) -> String {
    cols.iter().map(|c| q(c)).collect::<Vec<_>>().join(", ")
}

fn prec(n: i64) -> String {
    if n > 0 {
        format!("({n})")
    } else {
        String::new()
    }
}

/// Base64 without padding (Go's RawStdEncoding).
fn base64_raw(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len() * 4 / 3 + 3);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..=chunk.len() {
            out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

pub(crate) fn base64_raw_decode(text: &str) -> Result<Vec<u8>, String> {
    let value = |c: u8| -> Result<u32, String> {
        Ok(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(format!("illegal base64 data at input byte {}", 0)),
        } as u32)
    };
    let bytes = text.as_bytes();
    if bytes.len() % 4 == 1 {
        return Err(format!("illegal base64 data at input byte {}", bytes.len() - 1));
    }
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for (index, chunk) in bytes.chunks(4).enumerate() {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            let v = value(c).map_err(|_| format!("illegal base64 data at input byte {}", index * 4 + i))?;
            n |= v << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

/// The `-- orm-schema-v1` line that embeds the manifest in generated SQL.
pub fn manifest_metadata(m: &Manifest) -> String {
    format!("{SCHEMA_METADATA_PREFIX}{}\n", base64_raw(m.marshal_indent().as_bytes()))
}

/// A column default. MySQL accepts a literal default for TEXT, BLOB, JSON,
/// and geometry columns only in the expression form DEFAULT (value).
fn default_expression(c: &Col, sql_type: &str, dialect: &str) -> String {
    let v = c.default.as_deref().unwrap_or("");
    if v == "now" && dialect == "sqlite" {
        // text timestamps with six fraction digits, the form the executor binds and compares
        return "(strftime('%Y-%m-%d %H:%M:%f', 'now') || '000')".into();
    }
    if v == "now" {
        return if dialect == "mysql" && c.precision > 0 { format!("CURRENT_TIMESTAMP({})", c.precision) } else { "CURRENT_TIMESTAMP".into() };
    }
    if v == "null" {
        return "NULL".into();
    }
    if c.typ == "bool" {
        // MySQL BOOLEAN is TINYINT(1) and strict mode rejects a quoted
        // default; SQLite stores the value as INTEGER 0/1.
        let value = v.trim_matches(|ch| ch == '\'' || ch == '"').to_lowercase();
        let truthy = value == "1" || value == "true";
        return match (dialect == "postgres", truthy) {
            (true, true) => "true",
            (true, false) => "false",
            (false, true) => "1",
            (false, false) => "0",
        }
        .into();
    }
    let expr = if is_number(v) { v.to_owned() } else { format!("'{}'", sql_quote(v.trim_matches('\''))) };
    let t = sql_type.to_lowercase();
    if dialect == "mysql" && ["text", "blob", "json", "geometry", "point", "linestring", "polygon"].iter().any(|k| t.contains(k)) {
        return format!("({expr})");
    }
    expr
}

/// One column without table-level constraints.
#[doc(hidden)]
pub fn ddl_column(c: &Col, dialect: &str, quote: Quote) -> Result<String, String> {
    let sql_type = ddl_type(c, dialect)?;
    let mut line = format!("{} {sql_type}", quote(&c.name));
    if !c.nullable {
        line += " NOT NULL";
    }
    if c.default.is_some() {
        line += &format!(" DEFAULT {}", default_expression(c, &sql_type, dialect));
    }
    if c.on_update && dialect == "mysql" {
        line += " ON UPDATE CURRENT_TIMESTAMP";
        line += &prec(c.precision);
    }
    if c.auto && dialect == "mysql" {
        line += " AUTO_INCREMENT";
    }
    if c.auto && dialect == "postgres" {
        line += " GENERATED BY DEFAULT AS IDENTITY";
    }
    Ok(line)
}

/// The dialect storage type of a canonical column; MySQL keeps the raw type.
pub(crate) fn ddl_type(c: &Col, dialect: &str) -> Result<String, String> {
    if dialect == "mysql" && !c.raw.is_empty() {
        if c.raw.eq_ignore_ascii_case("uuid") {
            return Ok(MYSQL_UUID.into());
        }
        if c.typ == "jsontext" {
            // jsontext keeps the stored text, which a document type would normalize.
            return Ok(MYSQL_JSONTEXT.into());
        }
        if c.typ == "enum" {
            // MySQL takes the enum values as string literals.
            let values: Vec<String> = c.r#enum.iter().map(|v| format!("'{}'", sql_quote(v))).collect();
            return Ok(format!("enum({})", values.join(",")));
        }
        let mut t = c.raw.replace('_', ",");
        if c.unsigned && !t.contains("unsigned") {
            t += " unsigned";
        }
        return Ok(t);
    }
    let t = match dialect {
        "postgres" => match c.typ.as_str() {
            "i32" => "integer".into(),
            "i64" => "bigint".into(),
            "f64" => "double precision".into(),
            "decimal" => format!("numeric({},{})", c.precision, c.scale),
            "bool" => "boolean".into(),
            "string" | "enum" => {
                if c.raw.eq_ignore_ascii_case("uuid") {
                    "uuid".into()
                } else if c.len > 0 {
                    format!("varchar({})", c.len)
                } else {
                    "text".into()
                }
            }
            "text" => "text".into(),
            "bytes" => "bytea".into(),
            "date" => "date".into(),
            "time" => "time".into(),
            "datetime" => format!("timestamp{} with time zone", prec(c.precision)),
            // json keeps the stored text, so object member order survives.
            // The ordered-json text is stored as written.
            "jsontext" => "text".into(),
            "inet" => "inet".into(),
            "point" => "point".into(),
            _ => return Err(format!("no {dialect} type for {}", c.typ)),
        },
        "sqlite" => match c.typ.as_str() {
            "i32" | "i64" | "bool" => "INTEGER".into(),
            "f64" | "decimal" => "REAL".into(),
            "bytes" | "inet" => "BLOB".into(),
            _ => "TEXT".into(),
        },
        _ => return Err(format!("no {dialect} type for {}", c.typ)),
    };
    Ok(t)
}

#[doc(hidden)]
fn quoted_check_expression(expr: &str, quote: Quote) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = expr;
    while !rest.is_empty() {
        let Some(start) = rest.find('`') else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('`') else {
            return Err("CHECK expression has an unterminated backtick identifier".into());
        };
        let name = &after[..end];
        if name.is_empty() || name.contains(['`', '\0']) {
            return Err("CHECK expression has an invalid backtick identifier".into());
        }
        out.push_str(&quote(name));
        rest = &after[end + 1..];
    }
    Ok(out)
}

#[derive(Clone, Debug, PartialEq)]
struct ForeignKey {
    name: String,
    columns: Vec<String>,
    target: String,
    target_cols: Vec<String>,
    on_delete: String,
    deferred: bool,
}

fn foreign_key_target_entity<'a>(m: &'a Manifest, target: &str) -> Option<&'a Entity> {
    m.entities.get(target).or_else(|| m.entities.values().find(|e| e.table == target))
}

fn relation_matches_column_reference(e: &Entity, rel: &Rel) -> bool {
    !rel.keys.is_empty()
        && rel.keys.iter().all(|key| {
            e.column(&key.local)
                .and_then(|c| c.reference.as_ref())
                .is_some_and(|r| r.entity == rel.target && r.column == key.target)
        })
}

/// The foreign keys of an entity keyed by their columns.
fn entity_foreign_keys(m: &Manifest, e: &Entity, dialect: &str) -> BTreeMap<String, ForeignKey> {
    let mut out: BTreeMap<String, ForeignKey> = BTreeMap::new();
    let mut consumed = BTreeSet::new();
    for rel in e.relations.values() {
        if rel.kind != "one" || (!rel.foreign_key && !relation_matches_column_reference(e, rel)) {
            continue;
        }
        if rel.keys.is_empty() || rel.keys.iter().any(|k| e.column(&k.local).is_none()) {
            continue;
        }
        let columns: Vec<String> = rel.keys.iter().map(|k| k.local.clone()).collect();
        let target_cols: Vec<String> = rel.keys.iter().map(|k| k.target.clone()).collect();
        let name = bounded_identifier(&format!("fk_{}_{}", e.table, columns.join("_")), dialect);
        consumed.extend(columns.iter().cloned());
        out.insert(
            columns.join("\x1f"),
            ForeignKey { name, columns, target: rel.target.clone(), target_cols, on_delete: rel.on_delete.clone(), deferred: false },
        );
    }
    for c in &e.columns {
        let Some(r) = &c.reference else { continue };
        if consumed.contains(&c.name) {
            continue;
        }
        out.insert(
            c.name.clone(),
            ForeignKey {
                name: bounded_identifier(&format!("fk_{}_{}", e.table, c.name), dialect),
                columns: vec![c.name.clone()],
                target: r.entity.clone(),
                target_cols: vec![r.column.clone()],
                on_delete: String::new(),
                deferred: false,
            },
        );
    }
    for fk in m.external_fks.iter().filter(|fk| fk.entity == e.name) {
        let name = if fk.name.is_empty() {
            bounded_identifier(&format!("fk_{}_{}", e.table.replace('.', "_"), fk.columns.join("_")), dialect)
        } else {
            fk.name.clone()
        };
        let matched = out.iter_mut().find(|(_, existing)| {
            let target = m.entities.get(&existing.target).map_or(existing.target.as_str(), |t| t.table.as_str());
            target == fk.target_table && existing.columns == fk.columns && existing.target_cols == fk.target_columns
        });
        if let Some((_, existing)) = matched {
            existing.name = name;
            existing.deferred = fk.deferred;
            continue;
        }
        out.insert(
            format!("external:{}\x1e{}", fk.columns.join("\x1f"), fk.target_table),
            ForeignKey {
                name,
                columns: fk.columns.clone(),
                target: fk.target_table.clone(),
                target_cols: fk.target_columns.clone(),
                on_delete: fk.on_delete.clone(),
                deferred: fk.deferred,
            },
        );
    }
    out
}

fn foreign_key_clause(fk: &ForeignKey, m: &Manifest, dialect: &str, quote: Quote) -> String {
    let target = m.entities.get(&fk.target).map_or(fk.target.as_str(), |e| e.table.as_str());
    let mut stmt = format!(
        "CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
        quote(&bounded_identifier(&fk.name.replace('.', "_"), dialect)),
        join_quoted(&fk.columns, quote),
        quote(target),
        join_quoted(&fk.target_cols, quote)
    );
    stmt += match fk.on_delete.as_str() {
        "cascade" => " ON DELETE CASCADE",
        "setnull" => " ON DELETE SET NULL",
        _ => " ON DELETE RESTRICT",
    };
    if fk.deferred && (dialect == "postgres" || dialect == "sqlite") {
        stmt += " DEFERRABLE INITIALLY DEFERRED";
    }
    stmt
}

/// A stable parent-before-child order for inline foreign keys.
fn ddl_entity_order(m: &Manifest) -> Result<Vec<String>, String> {
    let mut position: HashMap<&str, usize> = HashMap::new();
    let mut names: Vec<&str> = Vec::new();
    for name in &m.order {
        position.insert(name, position.len());
        names.push(name);
    }
    for name in m.entities.keys() {
        if !position.contains_key(name.as_str()) {
            position.insert(name, position.len());
            names.push(name);
        }
    }
    fn visit<'a>(
        m: &'a Manifest,
        name: &'a str,
        position: &HashMap<&str, usize>,
        state: &mut HashMap<&'a str, u8>,
        result: &mut Vec<String>,
    ) -> Result<(), String> {
        match state.get(name) {
            Some(1) => return Err(format!("foreign key cycle includes {name}; deferred cyclic constraints are required")),
            Some(2) => return Ok(()),
            _ => {}
        }
        state.insert(name, 1);
        let e = &m.entities[name];
        let mut deps: BTreeSet<&str> = BTreeSet::new();
        for c in &e.columns {
            if let Some(r) = &c.reference {
                if r.entity != name && m.entities.contains_key(&r.entity) {
                    deps.insert(&r.entity);
                }
            }
        }
        for rel in e.relations.values() {
            if rel.foreign_key && rel.target != name && m.entities.contains_key(&rel.target) {
                deps.insert(&rel.target);
            }
        }
        let mut ordered: Vec<&str> = deps.into_iter().collect();
        ordered.sort_by_key(|d| position.get(d).copied().unwrap_or(usize::MAX));
        for dep in ordered {
            let dep = m.entities.get_key_value(dep).unwrap().0.as_str();
            visit(m, dep, position, state, result)?;
        }
        state.insert(name, 2);
        result.push(name.to_owned());
        Ok(())
    }
    let mut state = HashMap::new();
    let mut result = Vec::new();
    for name in names {
        visit(m, name, &position, &mut state, &mut result)?;
    }
    Ok(result)
}

/// The CREATE statements of a manifest, with a DROP before each table.
pub fn render_ddl(m: &Manifest, dialect: &str) -> Result<String, String> {
    let mysql_q = |s: &str| quote_qualified("`", s);
    let other_q = |s: &str| quote_qualified("\"", &ddl_table(s, dialect));
    let q: Quote = if dialect == "mysql" { &mysql_q } else { &other_q };
    let mut sb = format!("-- generated by ormgen ddl ({dialect}) from schema_hash {}\n", m.schema_hash);
    sb += &manifest_metadata(m);
    if dialect == "sqlite" {
        sb += "CREATE TABLE IF NOT EXISTS orm_schema_comments (table_name TEXT NOT NULL, column_name TEXT NOT NULL, comment TEXT NOT NULL, PRIMARY KEY (table_name, column_name));\n";
    }
    if dialect == "postgres" {
        for name in ddl_schemas(m) {
            sb += &format!("CREATE SCHEMA IF NOT EXISTS {};\n", q(&name));
        }
    }
    if dialect == "mysql" {
        // MySQL keeps a qualified table in the database named by its schema.
        for name in ddl_schemas(m) {
            sb += &format!("CREATE DATABASE IF NOT EXISTS {};\n", q(&name));
        }
    }
    let order = ddl_entity_order(m)?;
    for name in order.iter().rev() {
        sb += &format!("\nDROP TABLE IF EXISTS {};\n", q(&ddl_table(&m.entities[name].table, dialect)));
    }
    let position: HashMap<&str, usize> = order.iter().enumerate().map(|(i, n)| (n.as_str(), i)).collect();
    let mut deferred: Vec<(String, ForeignKey)> = Vec::new();
    for (current, name) in order.iter().enumerate() {
        let e = &m.entities[name];
        sb += &format!("\nCREATE TABLE {} (\n", q(&ddl_table(&e.table, dialect)));
        let mut lines = Vec::new();
        for c in &e.columns {
            let mut line = format!("  {}", ddl_column(c, dialect, q).map_err(|err| format!("{}.{}: {err}", e.table, c.name))?);
            if !c.comment.is_empty() && dialect == "mysql" {
                line += &format!(" COMMENT '{}'", sql_quote(&c.comment));
            }
            lines.push(line);
        }
        if dialect == "sqlite" && e.pk.len() == 1 && e.auto == e.pk[0] {
            let prefix = format!("  {} ", q(&e.pk[0]));
            for l in lines.iter_mut() {
                if l.starts_with(&prefix) {
                    *l = format!("  {} INTEGER PRIMARY KEY AUTOINCREMENT", q(&e.pk[0]));
                }
            }
        } else {
            lines.push(format!("  PRIMARY KEY ({})", join_quoted(&e.pk, q)));
        }
        for uk in &e.unique {
            lines.push(format!("  CONSTRAINT {} UNIQUE ({})", q(&bounded_identifier(&format!("uq_{}_{}", ddl_base(&e.table), uk.join("_")), dialect)), join_quoted(uk, q)));
        }
        for fk in entity_foreign_keys(m, e, dialect).into_values() {
            if let Some(target) = foreign_key_target_entity(m, &fk.target) {
                if dialect != "sqlite" && position.get(target.name.as_str()).is_some_and(|p| *p > current) {
                    deferred.push((e.table.clone(), fk));
                    continue;
                }
            }
            lines.push(format!("  {}", foreign_key_clause(&fk, m, dialect, q)));
        }
        for check in &e.checks {
            let expr = rendered_check_expression(&check.expr, dialect, q).map_err(|err| format!("{} check {}: {err}", e.table, check.name))?;
            lines.push(format!("  CONSTRAINT {} CHECK ({expr})", q(&ddl_check_name(&e.table, &check.name, dialect))));
        }
        if dialect == "mysql" {
            for (ix, cols) in &e.indexes {
                lines.push(format!("  KEY {} ({})", q(ix), join_quoted(cols, q)));
            }
            for cols in &e.fulltext {
                lines.push(format!("  FULLTEXT KEY {} ({})", q(&format!("ft_{}", cols.join("_"))), join_quoted(cols, q)));
            }
        }
        sb += &lines.join(",\n");
        sb += "\n)";
        if dialect == "mysql" {
            sb += " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";
        }
        sb += ";\n";
        if !e.comment.is_empty() {
            sb += &match dialect {
                "mysql" => format!("ALTER TABLE {} COMMENT = '{}';\n", q(&e.table), sql_quote(&e.comment)),
                "postgres" => format!("COMMENT ON TABLE {} IS '{}';\n", q(&e.table), sql_quote(&e.comment)),
                _ => format!(
                    "INSERT OR REPLACE INTO orm_schema_comments (table_name, column_name, comment) VALUES ('{}', '', '{}');\n",
                    sql_quote(&e.table),
                    sql_quote(&e.comment)
                ),
            };
        }
        for c in e.columns.iter().filter(|c| !c.comment.is_empty()) {
            if dialect == "postgres" {
                sb += &format!("COMMENT ON COLUMN {}.{} IS '{}';\n", q(&e.table), q(&c.name), sql_quote(&c.comment));
            } else if dialect == "sqlite" {
                sb += &format!(
                    "INSERT OR REPLACE INTO orm_schema_comments (table_name, column_name, comment) VALUES ('{}', '{}', '{}');\n",
                    sql_quote(&e.table),
                    sql_quote(&c.name),
                    sql_quote(&c.comment)
                );
            }
        }
        if dialect != "mysql" {
            for (ix, cols) in &e.indexes {
                sb += &format!("CREATE INDEX {} ON {} ({});\n", q(&ddl_index_name(&e.table, ix, dialect)), q(&e.table), join_quoted(cols, q));
            }
            if dialect == "postgres" {
                for cols in &e.fulltext {
                    let doc: Vec<String> = cols.iter().map(|c| format!("coalesce({}, '')", q(c))).collect();
                    sb += &format!(
                        "CREATE INDEX {} ON {} USING GIN (to_tsvector('simple', {}));\n",
                        q(&ddl_index_name(&e.table, &format!("ft_{}", cols.join("_")), dialect)),
                        q(&e.table),
                        doc.join(" || ' ' || ")
                    );
                }
            }
        }
    }
    for (table, fk) in &deferred {
        sb += &format!("ALTER TABLE {} ADD {};\n", q(table), foreign_key_clause(fk, m, dialect, q));
    }
    for o in trigger_objects(m, dialect)? {
        sb += &format!("\n{}\n", o.text());
    }
    Ok(sb)
}

/// The apply-safe form used by migrate: nothing is dropped and tables and
/// standalone indexes are created only when missing.
pub fn render_create_ddl(m: &Manifest, dialect: &str) -> Result<String, String> {
    let s = render_ddl(m, dialect)?;
    let out: Vec<String> = s
        .split('\n')
        .filter(|l| !l.starts_with("DROP TABLE IF EXISTS "))
        .map(|l| {
            l.replacen("CREATE TABLE `", "CREATE TABLE IF NOT EXISTS `", 1)
                .replacen("CREATE TABLE \"", "CREATE TABLE IF NOT EXISTS \"", 1)
                .replacen("CREATE INDEX `", "CREATE INDEX IF NOT EXISTS `", 1)
                .replacen("CREATE INDEX \"", "CREATE INDEX IF NOT EXISTS \"", 1)
        })
        .collect();
    Ok(out.join("\n"))
}

// ---- migration diff ----

pub(crate) struct Change {
    pub sql: String,
    pub destructive: bool,
}

fn change(sql: String) -> Change {
    Change { sql, destructive: false }
}

fn destructive(sql: String) -> Change {
    Change { sql, destructive: true }
}

/// The migration SQL from one manifest to another. Destructive changes
/// require `allow_destructive`.
pub fn render_diff(from: &Manifest, to: &Manifest, dialect: &str, allow_destructive: bool) -> Result<String, String> {
    let changes = diff_changes(from, to, dialect)?;
    for c in &changes {
        if c.destructive && !allow_destructive {
            return Err(format!("destructive schema change requires --allow-destructive: {}", c.sql));
        }
    }
    let mut b = format!("-- generated by ormgen diff ({dialect}) from {} to {}\n", from.schema_hash, to.schema_hash);
    b += &manifest_metadata(to);
    if changes.is_empty() {
        b += "-- no changes\n";
    }
    for c in &changes {
        b += &c.sql;
        b.push('\n');
    }
    Ok(b)
}

pub(crate) fn diff_changes(from: &Manifest, to: &Manifest, dialect: &str) -> Result<Vec<Change>, String> {
    check_dialect(dialect)?;
    let mysql_q = |s: &str| format!("`{s}`");
    let other_q = |s: &str| format!("\"{s}\"");
    let quote: Quote = if dialect == "mysql" { &mysql_q } else { &other_q };
    validate_rename_sources(from, to)?;
    let mut changes = Vec::new();
    let mut rebuilt = BTreeSet::new();
    for (old, next) in match_diff_entities(from, to) {
        match (old, next) {
            (None, Some(next)) => {
                let one = Manifest {
                    schema_hash: to.schema_hash.clone(),
                    order: vec![next.name.clone()],
                    entities: [(next.name.clone(), next.clone())].into_iter().collect(),
                    ..Default::default()
                };
                let create = remove_drop_statement(&render_ddl(&one, dialect)?);
                changes.push(change(create.trim().to_owned()));
            }
            (Some(old), None) => changes.push(destructive(format!("DROP TABLE {};", quote(&old.table)))),
            (Some(old), Some(next)) => {
                let mut table_rename = String::new();
                if old.table != next.table {
                    if next.renamed_from != old.name && old.renamed_from != next.name {
                        return Err(format!("table rename {} -> {} requires explicit migration", old.table, next.table));
                    }
                    table_rename = format!("ALTER TABLE {} RENAME TO {};", quote(&old.table), quote(&next.table));
                }
                if dialect == "sqlite" {
                    validate_sqlite_added_columns(old, next)?;
                    if sqlite_needs_rebuild(from, to, old, next) {
                        rebuilt.insert(old.table.clone());
                        rebuilt.insert(next.table.clone());
                        let statement = render_sqlite_rebuild(to, old, next, quote)?;
                        changes.push(destructive(statement));
                        continue;
                    }
                }
                let (drops, adds) = diff_indexes_and_foreign_keys(from, to, old, next, dialect, quote)?;
                let (check_drops, check_adds) = diff_checks(old, next, dialect, quote)?;
                changes.extend(drops);
                changes.extend(check_drops);
                if !table_rename.is_empty() {
                    changes.push(change(table_rename));
                }
                for (o, n) in match_diff_columns(old, next) {
                    match (o, n) {
                        (None, Some(n)) => {
                            let mut def = ddl_column(n, dialect, quote)?;
                            if dialect == "mysql" && !n.comment.is_empty() {
                                def += &format!(" COMMENT '{}'", sql_quote(&n.comment));
                            }
                            changes.push(change(format!("ALTER TABLE {} ADD COLUMN {def};", quote(&next.table))));
                            if dialect != "mysql" && !n.comment.is_empty() {
                                changes.push(change(alter_comment(&next.table, n, dialect, quote)?));
                            }
                        }
                        (Some(o), None) => changes.push(destructive(format!("ALTER TABLE {} DROP COLUMN {};", quote(&old.table), quote(&o.name)))),
                        (Some(o), Some(n)) => {
                            if o.name != n.name {
                                changes.push(change(format!("ALTER TABLE {} RENAME COLUMN {} TO {};", quote(&next.table), quote(&o.name), quote(&n.name))));
                            }
                            let changed = if dialect == "sqlite" { !sqlite_columns_equivalent(o, n) } else { column_changed(o, n, dialect) };
                            if changed {
                                let stmts = alter_column(&next.table, o, n, dialect, quote).map_err(|err| {
                                    format!(
                                        "column {}.{} changed from type={} raw={} nullable={} default={} to type={} raw={} nullable={} default={}: {err}",
                                        next.table,
                                        n.name,
                                        o.typ,
                                        o.raw,
                                        o.nullable,
                                        col_default(o),
                                        n.typ,
                                        n.raw,
                                        n.nullable,
                                        col_default(n)
                                    )
                                })?;
                                changes.extend(stmts.into_iter().map(destructive));
                            }
                            if o.comment != n.comment {
                                changes.push(change(alter_comment(&next.table, n, dialect, quote)?));
                            }
                        }
                        (None, None) => {}
                    }
                }
                if old.comment != next.comment {
                    changes.push(change(alter_table_comment(&next.table, &next.comment, dialect, quote)));
                }
                changes.extend(adds);
                changes.extend(check_adds);
            }
            (None, None) => {}
        }
    }
    let (drops, creates) = diff_triggers(from, to, dialect, &rebuilt)?;
    let mut out: Vec<Change> = drops.into_iter().map(change).collect();
    out.extend(changes);
    out.extend(creates.into_iter().map(change));
    Ok(out)
}

fn validate_sqlite_added_columns(old: &Entity, next: &Entity) -> Result<(), String> {
    for (previous, c) in match_diff_columns(old, next) {
        if let (None, Some(c)) = (previous, c) {
            if !c.nullable && c.default.is_none() && !c.auto {
                return Err(format!(
                    "sqlite table {} cannot add required column {} without a default during a data-preserving migration",
                    next.table, c.name
                ));
            }
        }
    }
    Ok(())
}

fn sqlite_needs_rebuild(from: &Manifest, to: &Manifest, old: &Entity, next: &Entity) -> bool {
    if old.pk != next.pk || !column_groups_equal(&old.unique, &next.unique) || !checks_equal(&old.checks, &next.checks) {
        return true;
    }
    for (o, n) in match_diff_columns(old, next) {
        match (o, n) {
            (_, None) => return true,
            (Some(o), Some(n)) if !sqlite_columns_equivalent(o, n) => return true,
            _ => {}
        }
    }
    let (old_fks, new_fks) = (entity_foreign_keys(from, old, ""), entity_foreign_keys(to, next, ""));
    if old_fks.len() != new_fks.len() {
        return true;
    }
    old_fks.iter().any(|(k, left)| new_fks.get(k).is_none_or(|right| !foreign_keys_equal(left, right, false)))
}

fn checks_equal(left: &[Check], right: &[Check]) -> bool {
    let keys = |v: &[Check]| {
        let mut out: Vec<String> = v.iter().map(|c| format!("{}\0{}", c.name, c.expr)).collect();
        out.sort();
        out
    };
    left.len() == right.len() && keys(left) == keys(right)
}

fn diff_checks(old: &Entity, next: &Entity, dialect: &str, quote: Quote) -> Result<(Vec<Change>, Vec<Change>), String> {
    if dialect == "sqlite" && !checks_equal(&old.checks, &next.checks) {
        return Err("sqlite CHECK constraint changes require a verified table rebuild".into());
    }
    let old_checks: BTreeMap<&str, &Check> = old.checks.iter().map(|c| (c.name.as_str(), c)).collect();
    let new_checks: BTreeMap<&str, &Check> = next.checks.iter().map(|c| (c.name.as_str(), c)).collect();
    let names: BTreeSet<&str> = old_checks.keys().chain(new_checks.keys()).copied().collect();
    let (mut drops, mut adds) = (Vec::new(), Vec::new());
    for name in names {
        let (o, n) = (old_checks.get(name), new_checks.get(name));
        let differs = match (o, n) {
            (Some(o), Some(n)) => o.expr != n.expr,
            _ => true,
        };
        if o.is_some() && differs {
            drops.push(destructive(format!("ALTER TABLE {} DROP CONSTRAINT {};", quote(&old.table), quote(&ddl_check_name(&old.table, name, dialect)))));
        }
        if let Some(n) = n.filter(|_| differs) {
            let expr = rendered_check_expression(&n.expr, dialect, quote).map_err(|err| format!("{} check {name}: {err}", next.table))?;
            adds.push(change(format!("ALTER TABLE {} ADD CONSTRAINT {} CHECK ({expr});", quote(&next.table), quote(&ddl_check_name(&next.table, name, dialect)))));
        }
    }
    Ok((drops, adds))
}

#[doc(hidden)]
pub fn sqlite_type_matches(want: &str, live: &str) -> bool {
    if want == live {
        return true;
    }
    match live {
        "i32" => matches!(want, "i32" | "i64" | "bool"),
        "f64" => matches!(want, "f64" | "decimal"),
        "text" => matches!(want, "string" | "text" | "jsontext" | "datetime" | "date" | "time" | "enum" | "point"),
        "bytes" => matches!(want, "bytes" | "inet"),
        _ => false,
    }
}

fn sqlite_columns_equivalent(left: &Col, right: &Col) -> bool {
    let type_match = sqlite_type_matches(&right.typ, &left.typ) || sqlite_type_matches(&left.typ, &right.typ);
    type_match && left.nullable == right.nullable && normalized_default(left) == normalized_default(right) && left.auto == right.auto
}

fn normalized_default(c: &Col) -> &str {
    c.default.as_deref().map_or("", |d| d.trim_matches(['\'', '"']))
}

fn column_groups_equal(left: &[Vec<String>], right: &[Vec<String>]) -> bool {
    let keys = |v: &[Vec<String>]| {
        let mut out: Vec<String> = v.iter().map(|g| g.join("\0")).collect();
        out.sort();
        out
    };
    left.len() == right.len() && keys(left) == keys(right)
}

fn render_sqlite_rebuild(to: &Manifest, old: &Entity, next: &Entity, quote: Quote) -> Result<String, String> {
    let temp = format!("__orm_rebuild_{}", next.table);
    let mut lines = Vec::new();
    for c in &next.columns {
        lines.push(format!("  {}", ddl_column(c, "sqlite", quote)?));
    }
    if next.pk.len() == 1 && next.auto == next.pk[0] {
        let prefix = format!("  {} ", quote(&next.pk[0]));
        for l in lines.iter_mut() {
            if l.starts_with(&prefix) {
                *l = format!("  {} INTEGER PRIMARY KEY AUTOINCREMENT", quote(&next.pk[0]));
            }
        }
    } else {
        lines.push(format!("  PRIMARY KEY ({})", join_quoted(&next.pk, quote)));
    }
    for unique in &next.unique {
        lines.push(format!("  CONSTRAINT {} UNIQUE ({})", quote(&bounded_identifier(&format!("uq_{}_{}", next.table, unique.join("_")), "sqlite")), join_quoted(unique, quote)));
    }
    for fk in entity_foreign_keys(to, next, "sqlite").into_values() {
        lines.push(format!("  {}", foreign_key_clause(&fk, to, "sqlite", quote)));
    }
    for check in &next.checks {
        let expr = rendered_check_expression(&check.expr, "sqlite", quote).map_err(|err| format!("{} check {}: {err}", next.table, check.name))?;
        lines.push(format!("  CONSTRAINT {} CHECK ({expr})", quote(&check.name)));
    }
    let (mut target_cols, mut source_cols) = (Vec::new(), Vec::new());
    for (o, n) in match_diff_columns(old, next) {
        if let (Some(o), Some(n)) = (o, n) {
            target_cols.push(quote(&n.name));
            source_cols.push(quote(&o.name));
        }
    }
    let mut b = format!("SELECT 'orm-sqlite-rebuild table={} target={} temp={temp}';\n", old.table, next.table);
    b += "PRAGMA defer_foreign_keys = ON;\n";
    b += &format!("CREATE TABLE {} (\n{}\n);\n", quote(&temp), lines.join(",\n"));
    if !target_cols.is_empty() {
        b += &format!("INSERT INTO {} ({}) SELECT {} FROM {};\n", quote(&temp), target_cols.join(", "), source_cols.join(", "), quote(&old.table));
    }
    b += &format!("DROP TABLE {};\n", quote(&old.table));
    b += &format!("ALTER TABLE {} RENAME TO {};\n", quote(&temp), quote(&next.table));
    for (name, cols) in &next.indexes {
        b += &format!("CREATE INDEX {} ON {} ({});\n", quote(&format!("{}_{name}", next.table)), quote(&next.table), join_quoted(cols, quote));
    }
    b += "CREATE TABLE IF NOT EXISTS orm_schema_comments (table_name TEXT NOT NULL, column_name TEXT NOT NULL, comment TEXT NOT NULL, PRIMARY KEY (table_name, column_name));\n";
    b += &format!("DELETE FROM orm_schema_comments WHERE table_name='{}';\n", sql_quote(&old.table));
    if !next.comment.is_empty() {
        b += &format!(
            "INSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('{}','','{}');\n",
            sql_quote(&next.table),
            sql_quote(&next.comment)
        );
    }
    for c in next.columns.iter().filter(|c| !c.comment.is_empty()) {
        b += &format!(
            "INSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('{}','{}','{}');\n",
            sql_quote(&next.table),
            sql_quote(&c.name),
            sql_quote(&c.comment)
        );
    }
    Ok(b.trim().to_owned())
}

fn validate_rename_sources(from: &Manifest, to: &Manifest) -> Result<(), String> {
    for next in to.entities.values() {
        let mut old = from.entities.get(&next.name);
        if !next.renamed_from.is_empty() && old.is_none() {
            old = from.entities.get(&next.renamed_from);
            if old.is_none() {
                return Err(format!("table {} rename source {} does not exist", next.name, next.renamed_from));
            }
        }
        let Some(old) = old else { continue };
        for column in next.columns.iter().filter(|c| !c.renamed_from.is_empty()) {
            if old.column(&column.name).is_none() && old.column(&column.renamed_from).is_none() {
                return Err(format!("column {}.{} rename source {} does not exist", next.name, column.name, column.renamed_from));
            }
        }
    }
    Ok(())
}

type EntityPair<'a> = (Option<&'a Entity>, Option<&'a Entity>);

fn match_diff_entities<'a>(from: &'a Manifest, to: &'a Manifest) -> Vec<EntityPair<'a>> {
    let mut used = BTreeSet::new();
    let mut pairs = Vec::new();
    for (name, next) in &to.entities {
        let mut old = from.entities.get(name);
        if old.is_none() && !next.renamed_from.is_empty() {
            old = from.entities.get(&next.renamed_from);
        }
        if old.is_none() {
            old = from.entities.values().find(|c| c.renamed_from == *name);
        }
        if let Some(o) = old {
            used.insert(o.name.clone());
        }
        pairs.push((old, Some(next)));
    }
    for (name, old) in &from.entities {
        if !used.contains(name) {
            pairs.push((Some(old), None));
        }
    }
    pairs
}

type ColumnPair<'a> = (Option<&'a Col>, Option<&'a Col>);

fn match_diff_columns<'a>(old: &'a Entity, next: &'a Entity) -> Vec<ColumnPair<'a>> {
    let mut used = BTreeSet::new();
    let mut out = Vec::new();
    for n in &next.columns {
        let mut o = old.column(&n.name);
        if o.is_none() && !n.renamed_from.is_empty() {
            o = old.column(&n.renamed_from);
        }
        if o.is_none() {
            o = old.columns.iter().find(|c| c.renamed_from == n.name);
        }
        if let Some(o) = o {
            used.insert(o.name.as_str());
        }
        out.push((o, Some(n)));
    }
    for o in &old.columns {
        if !used.contains(o.name.as_str()) {
            out.push((Some(o), None));
        }
    }
    out
}

fn remove_drop_statement(s: &str) -> String {
    s.split('\n').filter(|l| !l.starts_with("DROP TABLE IF EXISTS ") && !l.starts_with("-- generated by")).collect::<Vec<_>>().join("\n")
}

/// A physical column difference. The update time is a column property only on
/// MySQL; the other dialects assign it in the planned UPDATE statement.
fn column_changed(a: &Col, b: &Col, dialect: &str) -> bool {
    column_storage(a, dialect) != column_storage(b, dialect)
        || a.nullable != b.nullable
        || col_default(a) != col_default(b)
        || a.auto != b.auto
        || (dialect == "mysql" && a.on_update != b.on_update)
        || a.unsigned != b.unsigned
        || a.precision != b.precision
        || a.scale != b.scale
}

/// The type, raw type, and length a dialect stores; a MySQL uuid column is
/// char(36).
pub(crate) fn column_storage<'a>(c: &'a Col, dialect: &str) -> (&'a str, &'a str, i64) {
    if dialect == "mysql" && c.raw.eq_ignore_ascii_case("uuid") {
        return (&c.typ, MYSQL_UUID, 36);
    }
    if c.typ == "jsontext" || c.typ == "text" {
        return ("text", if dialect == "mysql" { MYSQL_JSONTEXT } else { "text" }, 0);
    }
    (&c.typ, &c.raw, c.len)
}

fn col_default(c: &Col) -> &str {
    c.default.as_deref().unwrap_or("")
}

fn alter_column(table: &str, old: &Col, next: &Col, dialect: &str, quote: Quote) -> Result<Vec<String>, String> {
    match dialect {
        "mysql" => {
            let mut def = ddl_column(next, dialect, quote)?;
            if !next.comment.is_empty() {
                def += &format!(" COMMENT '{}'", sql_quote(&next.comment));
            }
            Ok(vec![format!("ALTER TABLE {} MODIFY COLUMN {def};", quote(table))])
        }
        "postgres" => {
            let mut out = Vec::new();
            let (old_type, new_type) = (ddl_type(old, dialect)?, ddl_type(next, dialect)?);
            let prefix = format!("ALTER TABLE {} ALTER COLUMN {} ", quote(table), quote(&next.name));
            if old_type != new_type {
                out.push(format!("{prefix}TYPE {new_type};"));
            }
            if old.nullable != next.nullable {
                out.push(format!("{prefix}{}", if next.nullable { "DROP NOT NULL;" } else { "SET NOT NULL;" }));
            }
            if col_default(old) != col_default(next) || old.default.is_none() != next.default.is_none() {
                match &next.default {
                    None => out.push(format!("{prefix}DROP DEFAULT;")),
                    Some(_) => out.push(format!("{prefix}SET DEFAULT {};", ddl_default(next, dialect))),
                }
            }
            if old.auto != next.auto {
                out.push(format!("{prefix}{}", if next.auto { "ADD GENERATED BY DEFAULT AS IDENTITY;" } else { "DROP IDENTITY IF EXISTS;" }));
            }
            if out.is_empty() {
                return Err("postgres does not support the requested attribute change".into());
            }
            Ok(out)
        }
        "sqlite" => Err("sqlite does not support deterministic ALTER COLUMN; recreate the table explicitly".into()),
        _ => Err(format!("unknown dialect {}", crate::schema::go_quote(dialect))),
    }
}

fn ddl_default(c: &Col, dialect: &str) -> String {
    let sql_type = ddl_type(c, dialect).unwrap_or_default();
    default_expression(c, &sql_type, dialect)
}

#[derive(Clone)]
struct Index {
    name: String,
    kind: &'static str,
    cols: Vec<String>,
}

/// The physical indexes of an entity. SQLite evaluates full-text conditions
/// without an index, so it has no full-text objects.
fn entity_indexes(e: &Entity, dialect: &str) -> BTreeMap<String, Index> {
    let mut out = BTreeMap::new();
    for (name, cols) in &e.indexes {
        out.insert(format!("index:{name}"), Index { name: name.clone(), kind: "index", cols: cols.clone() });
    }
    for cols in &e.unique {
        let name = bounded_identifier(&format!("uq_{}_{}", e.table, cols.join("_")), dialect);
        out.insert(format!("unique:{name}"), Index { name, kind: "unique", cols: cols.clone() });
    }
    for cols in e.fulltext.iter().filter(|_| dialect != "sqlite") {
        let name = format!("ft_{}", cols.join("_"));
        out.insert(format!("fulltext:{name}"), Index { name, kind: "fulltext", cols: cols.clone() });
    }
    out
}

fn foreign_keys_equal(left: &ForeignKey, right: &ForeignKey, compare_name: bool) -> bool {
    (!compare_name || left.name == right.name)
        && left.columns == right.columns
        && left.target == right.target
        && left.target_cols == right.target_cols
        && left.on_delete == right.on_delete
        && left.deferred == right.deferred
}

fn diff_indexes_and_foreign_keys(
    from: &Manifest,
    to: &Manifest,
    old: &Entity,
    next: &Entity,
    dialect: &str,
    quote: Quote,
) -> Result<(Vec<Change>, Vec<Change>), String> {
    let (old_ix, new_ix) = (entity_indexes(old, dialect), entity_indexes(next, dialect));
    let (mut index_drops, mut index_adds, mut fk_drops, mut fk_adds) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let keys: BTreeSet<&String> = old_ix.keys().chain(new_ix.keys()).collect();
    for key in keys {
        let (o, n) = (old_ix.get(key), new_ix.get(key));
        if let (Some(o), Some(n)) = (o, n) {
            if o.kind == n.kind && o.cols == n.cols {
                continue;
            }
        }
        if let Some(o) = o {
            index_drops.push(change(drop_index(&old.table, o, dialect, quote)?));
        }
        if let Some(n) = n {
            index_adds.push(change(create_index(&next.table, n, dialect, quote)?));
        }
    }
    let (old_fks, new_fks) = (entity_foreign_keys(from, old, dialect), entity_foreign_keys(to, next, dialect));
    let keys: BTreeSet<&String> = old_fks.keys().chain(new_fks.keys()).collect();
    for key in keys {
        let (o, n) = (old_fks.get(key), new_fks.get(key));
        if let (Some(o), Some(n)) = (o, n) {
            if foreign_keys_equal(o, n, dialect != "sqlite") {
                continue;
            }
        }
        if dialect == "sqlite" {
            return Err("sqlite foreign key changes require a verified table rebuild".into());
        }
        if let Some(o) = o {
            let verb = if dialect == "mysql" { "DROP FOREIGN KEY" } else { "DROP CONSTRAINT" };
            fk_drops.push(change(format!("ALTER TABLE {} {verb} {};", quote(&old.table), quote(&o.name))));
        }
        if let Some(n) = n {
            fk_adds.push(change(format!("ALTER TABLE {} ADD {};", quote(&next.table), foreign_key_clause(n, to, dialect, quote))));
        }
    }
    fk_drops.extend(index_drops);
    index_adds.extend(fk_adds);
    Ok((fk_drops, index_adds))
}

fn drop_index(table: &str, index: &Index, dialect: &str, quote: Quote) -> Result<String, String> {
    if index.kind == "unique" {
        match dialect {
            "postgres" => return Ok(format!("ALTER TABLE {} DROP CONSTRAINT {};", quote(table), quote(&index.name))),
            "sqlite" => return Err("sqlite unique constraint changes require a verified table rebuild".into()),
            _ => {}
        }
    }
    let mut name = index.name.clone();
    if dialect != "mysql" && index.kind != "unique" {
        name = format!("{table}_{name}");
    }
    if dialect == "mysql" {
        return Ok(format!("DROP INDEX {} ON {};", quote(&name), quote(table)));
    }
    Ok(format!("DROP INDEX {};", quote(&name)))
}

fn create_index(table: &str, index: &Index, dialect: &str, quote: Quote) -> Result<String, String> {
    if index.kind == "unique" {
        match dialect {
            "postgres" => {
                return Ok(format!("ALTER TABLE {} ADD CONSTRAINT {} UNIQUE ({});", quote(table), quote(&index.name), join_quoted(&index.cols, quote)))
            }
            "sqlite" => return Err("sqlite unique constraint changes require a verified table rebuild".into()),
            _ => {}
        }
    }
    let mut name = index.name.clone();
    if dialect != "mysql" && index.kind != "unique" {
        name = format!("{table}_{name}");
    }
    let cols = join_quoted(&index.cols, quote);
    match index.kind {
        "index" => Ok(format!("CREATE INDEX {} ON {} ({cols});", quote(&name), quote(table))),
        "unique" => Ok(format!("CREATE UNIQUE INDEX {} ON {} ({cols});", quote(&name), quote(table))),
        _ => match dialect {
            "mysql" => Ok(format!("CREATE FULLTEXT INDEX {} ON {} ({cols});", quote(&name), quote(table))),
            "postgres" => {
                let doc: Vec<String> = index.cols.iter().map(|c| format!("coalesce({}, '')", quote(c))).collect();
                Ok(format!("CREATE INDEX {} ON {} USING GIN (to_tsvector('simple', {}));", quote(&name), quote(table), doc.join(" || ' ' || ")))
            }
            _ => Err(format!("unknown index kind {}", crate::schema::go_quote(index.kind))),
        },
    }
}

fn alter_table_comment(table: &str, comment: &str, dialect: &str, quote: Quote) -> String {
    let q = sql_quote(comment);
    match dialect {
        "mysql" => format!("ALTER TABLE {} COMMENT = '{q}';", quote(table)),
        "postgres" if comment.is_empty() => format!("COMMENT ON TABLE {} IS NULL;", quote(table)),
        "postgres" => format!("COMMENT ON TABLE {} IS '{q}';", quote(table)),
        _ if comment.is_empty() => format!("DELETE FROM orm_schema_comments WHERE table_name='{}' AND column_name='';", sql_quote(table)),
        _ => format!("INSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('{}','','{q}');", sql_quote(table)),
    }
}

fn alter_comment(table: &str, c: &Col, dialect: &str, quote: Quote) -> Result<String, String> {
    let q = sql_quote(&c.comment);
    Ok(match dialect {
        "mysql" => format!("ALTER TABLE {} MODIFY COLUMN {} COMMENT '{q}';", quote(table), ddl_column(c, dialect, quote)?),
        "postgres" if c.comment.is_empty() => format!("COMMENT ON COLUMN {}.{} IS NULL;", quote(table), quote(&c.name)),
        "postgres" => format!("COMMENT ON COLUMN {}.{} IS '{q}';", quote(table), quote(&c.name)),
        _ if c.comment.is_empty() => {
            format!("DELETE FROM orm_schema_comments WHERE table_name='{}' AND column_name='{}';", sql_quote(table), sql_quote(&c.name))
        }
        _ => format!(
            "CREATE TABLE IF NOT EXISTS orm_schema_comments (table_name TEXT NOT NULL, column_name TEXT NOT NULL, comment TEXT NOT NULL, PRIMARY KEY (table_name, column_name));\nINSERT OR REPLACE INTO orm_schema_comments (table_name,column_name,comment) VALUES ('{}','{}','{q}');",
            sql_quote(table),
            sql_quote(&c.name)
        ),
    })
}

/// Reads the manifest embedded in ormgen or orm-gen SQL.
pub fn manifest_from_ddl(path: &str, text: &str) -> Result<Manifest, String> {
    for line in text.split('\n') {
        let Some(encoded) = line.strip_prefix(SCHEMA_METADATA_PREFIX) else { continue };
        let decoded = base64_raw_decode(encoded.trim()).map_err(|e| format!("MIGRATION_SOURCE: {path}: invalid orm-schema-v1 metadata: {e}"))?;
        let json = String::from_utf8(decoded).map_err(|e| format!("MIGRATION_SOURCE: {path}: invalid embedded manifest: {e}"))?;
        return Manifest::load(&json).map_err(|e| format!("MIGRATION_SOURCE: {path}: invalid embedded manifest: {e}"));
    }
    Err(format!("MIGRATION_SOURCE_LOSS: {path} has no orm-schema-v1 metadata; SQL cannot represent codec styles or relation options"))
}
