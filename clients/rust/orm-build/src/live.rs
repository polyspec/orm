//! A live database schema as read from the catalog, and its Mermaid form.
//!
//! The rendering is deterministic (tables alphabetical, columns by position),
//! so a re-import of an unchanged database produces no diff. When a previous
//! diagram is given, the facts the database cannot express are carried over:
//! relation names, `lazy`, `bool`, `int`, and explicit styles.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use crate::ddl::is_number;
use crate::schema::{self, go_quote, DColumn, DRelation, Diagram, Manifest};

/// "No default" in [`Column::default`].
pub const NO_DEFAULT: &str = "\0";

#[derive(Debug, Clone, Default)]
pub struct Column {
    pub name: String,
    /// The MySQL-shaped type text (`bigint unsigned`, `decimal(13,3)`).
    pub typ: String,
    /// The default text, or [`NO_DEFAULT`].
    pub default: String,
    pub extra: String,
    /// `PRI` for a primary-key column.
    pub key: String,
    pub nullable: bool,
    pub comment: String,
}

#[derive(Debug, Clone, Default)]
pub struct Index {
    pub name: String,
    pub unique: bool,
    pub fulltext: bool,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub target: String,
    pub target_columns: Vec<String>,
    pub on_delete: String,
}

#[derive(Debug, Clone, Default)]
pub struct Check {
    pub name: String,
    pub expr: String,
}

#[derive(Debug, Clone, Default)]
pub struct Table {
    pub name: String,
    pub comment: String,
    pub columns: Vec<Column>,
    pub indexes: Vec<Index>,
    pub foreign_keys: Vec<ForeignKey>,
    pub checks: Vec<Check>,
}

/// The tables without the migration history and setting tables the tools
/// manage.
pub fn without_managed(tables: &[Table]) -> Vec<Table> {
    tables.iter().filter(|t| t.name != "orm_schema_migrations" && t.name != "orm__context").cloned().collect()
}

/// The manifest of live tables, built the way a migration reads its source:
/// the managed tables are ignored and AES version metadata may be missing.
/// `trigger_bodies` are the live trigger bodies that carry ORM markers.
pub fn manifest(tables: &[Table], trigger_bodies: &[String]) -> Result<Manifest, String> {
    let tables = without_managed(tables);
    if tables.is_empty() {
        return Ok(Manifest::default());
    }
    let d = schema::parse(&with_trigger_directives(&tables, trigger_bodies, render_mermaid(&tables, None))).map_err(|e| e.to_string())?;
    schema::build_migration_source(&[d]).map_err(|e| e.to_string())
}

/// Appends the directives of the live ORM triggers on the imported tables to
/// a rendered diagram.
pub fn with_trigger_directives(tables: &[Table], trigger_bodies: &[String], mut text: String) -> String {
    let names: std::collections::BTreeSet<String> = tables.iter().map(|t| t.name.clone()).collect();
    for line in orm_schema::triggers::trigger_directives(trigger_bodies, &names) {
        text += "  ";
        text += &line;
        text.push('\n');
    }
    text
}

/// The parent table of a `<role>_<table>_seq` column, found by dropping
/// leading words until a table name matches.
pub fn fk_target(col: &str, tables: &HashSet<&str>) -> Option<String> {
    let base = col.strip_suffix("_seq")?;
    let parts: Vec<&str> = base.split('_').collect();
    (0..parts.len()).map(|i| parts[i..].join("_")).find(|t| tables.contains(t.as_str()))
}

/// Rewrites a MySQL column type into the diagram spelling: `bigint unsigned`
/// → `bigint` plus the unsigned attribute, `decimal(13,3)` → `decimal(13_3)`,
/// `enum('a','b')` → `enum(a_b)`.
/// Names a text column that carries the json codec as jsontext, the type the
/// ORM declares for the ordered-json text.
pub fn imported_json_text(name: &str, typ: String) -> String {
    if typ == "jsontext" || (!name.starts_with("json_") && !name.starts_with("jsons_")) {
        return typ;
    }
    if matches!(typ.as_str(), "text" | "longtext" | "mediumtext" | "tinytext") {
        return "jsontext".into();
    }
    typ
}

pub fn mermaid_type(t: &str) -> (String, bool) {
    let mut t = t.to_lowercase();
    let unsigned = t.ends_with(" unsigned");
    if unsigned {
        t.truncate(t.len() - " unsigned".len());
    }
    if let Some(i) = t.find('(') {
        if t.ends_with(')') {
            let inner = t[i + 1..t.len() - 1].replace('\'', "").replace(',', "_");
            t = format!("{}({inner})", &t[..i]);
        }
    }
    (t, unsigned)
}

/// The Mermaid diagram of live tables.
pub fn render_mermaid(ts: &[Table], prev: Option<&Diagram>) -> String {
    let tables: HashSet<&str> = ts.iter().map(|t| t.name.as_str()).collect();
    let mut primary: HashMap<&str, Vec<String>> = HashMap::new();
    for t in ts {
        for c in t.columns.iter().filter(|c| c.key == "PRI") {
            primary.entry(&t.name).or_default().push(c.name.clone());
        }
    }
    let mut prev_cols: HashMap<String, &DColumn> = HashMap::new();
    let mut prev_labels: HashMap<String, &DRelation> = HashMap::new();
    if let Some(prev) = prev {
        for e in &prev.entities {
            for c in &e.columns {
                prev_cols.insert(format!("{}.{}", e.name, c.name), c);
            }
        }
        for r in &prev.relations {
            prev_labels.insert(format!("{}/{}/{}", r.parent, r.child, r.fks.join(",")), r);
        }
    }
    struct Rel {
        parent: String,
        child: String,
        on_delete: String,
        fks: Vec<String>,
    }
    let mut sb = String::from("erDiagram\n");
    let mut rels: Vec<Rel> = Vec::new();
    let mut directives: Vec<String> = Vec::new();
    for t in ts {
        sb += &format!("  {} {{\n", t.name);
        let mut single: HashMap<&str, &Index> = HashMap::new();
        for ix in t.indexes.iter().filter(|ix| ix.columns.len() == 1) {
            single.insert(&ix.columns[0], ix);
        }
        let mut foreign_by_column: HashMap<&str, (&ForeignKey, usize)> = HashMap::new();
        for fk in &t.foreign_keys {
            if fk.columns.len() != fk.target_columns.len() {
                continue;
            }
            for (i, column) in fk.columns.iter().enumerate() {
                foreign_by_column.insert(column, (fk, i));
            }
            if fk.target != t.name && primary.get(fk.target.as_str()).map_or(fk.target_columns.is_empty(), |p| *p == fk.target_columns) {
                rels.push(Rel { parent: fk.target.clone(), child: t.name.clone(), fks: fk.columns.clone(), on_delete: fk.on_delete.clone() });
            }
        }
        for c in &t.columns {
            let (typ, unsigned) = mermaid_type(&c.typ);
            let typ = imported_json_text(&c.name, typ);
            let mut keys: Vec<&str> = Vec::new();
            if c.key == "PRI" {
                keys.push("PK");
            }
            let target = match foreign_by_column.get(c.name.as_str()) {
                Some((fk, _)) => Some(fk.target.clone()),
                None => fk_target(&c.name, &tables),
            };
            if target.as_ref().is_some_and(|t2| !t2.is_empty() && *t2 != t.name) {
                keys.push("FK");
            }
            if let Some(ix) = single.get(c.name.as_str()) {
                if ix.unique && c.key != "PRI" {
                    keys.push("UK");
                }
            }
            let mut attrs: Vec<String> = Vec::new();
            if c.nullable {
                attrs.push("?".into());
            }
            if c.default == NO_DEFAULT {
            } else if c.default.to_uppercase().starts_with("CURRENT_TIMESTAMP") {
                attrs.push("=now".into());
            } else if c.nullable && c.default.eq_ignore_ascii_case("NULL") {
            } else {
                let mut d = c.default.clone();
                if d.contains(' ') || (!is_number(&d) && !d.starts_with('\'')) {
                    d = format!("'{d}'");
                }
                attrs.push(format!("={d}"));
            }
            if c.extra.to_lowercase().contains("on update current_timestamp") {
                attrs.push("onupdate".into());
            }
            if c.extra.contains("auto_increment") {
                attrs.push("auto".into());
            }
            if unsigned && !c.name.starts_with("is_") {
                attrs.push("unsigned".into());
            }
            if let Some(pc) = prev_cols.get(&format!("{}.{}", t.name, c.name)) {
                if pc.lazy {
                    attrs.push("lazy".into());
                }
                if pc.bool_ {
                    attrs.push("bool".into());
                }
                if pc.int {
                    attrs.push("int".into());
                }
                attrs.extend(pc.styles.iter().cloned());
            }
            let mut line = format!("    {typ:<13} {:<28}", c.name);
            if !keys.is_empty() {
                line += &format!(" {}", keys.join(", "));
            }
            if !attrs.is_empty() {
                line += &format!(" {}", go_quote(&attrs.join(" ")));
            }
            sb += line.trim_end_matches(' ');
            sb.push('\n');
        }
        sb += "  }\n";
        if !t.comment.is_empty() {
            directives.push(format!("  %% table_comment {} {}", t.name, quote_directive(&t.comment)));
        }
        for c in t.columns.iter().filter(|c| !c.comment.is_empty()) {
            directives.push(format!("  %% column_comment {} {} {}", t.name, c.name, quote_directive(&c.comment)));
        }
        for ix in &t.indexes {
            let cols = format!("({})", ix.columns.join(", "));
            if ix.fulltext {
                directives.push(format!("  %% fulltext {} {cols}", t.name));
            } else if ix.unique && ix.columns.len() > 1 {
                directives.push(format!("  %% unique {} {cols}", t.name));
            } else if ix.unique || (ix.columns.len() == 1 && fk_target(&ix.columns[0], &tables).is_some()) {
            } else {
                directives.push(format!("  %% index {} {cols} {}", t.name, ix.name));
            }
        }
        for check in &t.checks {
            directives.push(format!("  %% check {} {} : {}", t.name, check.name, check.expr));
        }
    }
    if !rels.is_empty() {
        sb.push('\n');
    }
    for r in &rels {
        let mut label = if r.fks.len() > 1 { format!("({})", r.fks.join(", ")) } else { r.fks[0].clone() };
        let prev = prev_labels.get(&format!("{}/{}/{}", r.parent, r.child, r.fks.join(",")));
        match prev {
            Some(pr) if !pr.child_name.is_empty() || !pr.parent_name.is_empty() => label += &format!(" ({} / {})", pr.child_name, pr.parent_name),
            _ if r.fks.len() > 1 => label += &format!(" ({} / {})", r.parent, import_plural(&r.child)),
            _ => {}
        }
        if !r.on_delete.is_empty() {
            label += &format!(" {}", r.on_delete);
        }
        sb += &format!("  {:<14} ||--o{{ {:<14} : {label}\n", r.parent, r.child);
    }
    if !directives.is_empty() {
        sb.push('\n');
    }
    for d in directives {
        sb += &d;
        sb.push('\n');
    }
    sb
}

fn import_plural(value: &str) -> String {
    let b = value.as_bytes();
    if value.ends_with('y') && b.len() > 1 && !b"aeiou".contains(&b[b.len() - 2]) {
        format!("{}ies", &value[..value.len() - 1])
    } else if value.ends_with('s') || value.ends_with('x') || value.ends_with("ch") || value.ends_with("sh") {
        format!("{value}es")
    } else {
        format!("{value}s")
    }
}

/// The diagram action of a catalog delete rule.
pub fn import_delete_action(action: &str) -> String {
    match action.replace('_', " ").to_uppercase().as_str() {
        "CASCADE" => "cascade".into(),
        "SET NULL" => "setnull".into(),
        _ => String::new(),
    }
}

fn quote_directive(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\\\\\""))
}

/// The diagram action of a PostgreSQL `confdeltype`.
pub fn postgres_delete_action(code: &str) -> String {
    match code {
        "c" => "cascade".into(),
        "n" => "setnull".into(),
        _ => String::new(),
    }
}

/// The index name the DDL declared: non-unique PostgreSQL indexes carry the
/// table name as a prefix.
pub fn postgres_logical_index_name(table: &str, physical: &str, unique: bool) -> String {
    if unique {
        physical.to_owned()
    } else {
        physical.strip_prefix(&format!("{table}_")).unwrap_or(physical).to_owned()
    }
}

static POSTGRES_COALESCE_COLUMN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)coalesce\s*\(\s*\(?\s*"?([a-z_][a-z0-9_]*)"?\s*,"#).unwrap());

/// The columns of a generated PostgreSQL full-text index.
pub fn postgres_fulltext_columns(definition: &str) -> Result<Vec<String>, String> {
    if !definition.to_lowercase().contains("to_tsvector") {
        return Err(format!("unsupported PostgreSQL GIN expression: {definition}"));
    }
    let mut seen = BTreeSet::new();
    let mut columns = Vec::new();
    for m in POSTGRES_COALESCE_COLUMN.captures_iter(definition) {
        if seen.insert(m[1].to_owned()) {
            columns.push(m[1].to_owned());
        }
    }
    if columns.is_empty() {
        return Err(format!("unsupported PostgreSQL GIN expression: {definition}"));
    }
    Ok(columns)
}

/// A PostgreSQL column as the type text the diagram uses.
pub fn pg_type_text(data_type: &str, udt: &str, char_len: Option<i64>, num_prec: Option<i64>, num_scale: Option<i64>, dt_prec: Option<i64>) -> String {
    match data_type {
        "character varying" | "character" => match char_len {
            Some(n) => format!("varchar({n})"),
            None => "text".into(),
        },
        "integer" => "int".into(),
        "smallint" => "smallint".into(),
        "bigint" => "bigint".into(),
        "boolean" => "tinyint".into(),
        "double precision" | "real" => "double".into(),
        "numeric" => match num_prec {
            Some(p) => format!("decimal({p},{})", num_scale.unwrap_or(0)),
            None => "decimal".into(),
        },
        "timestamp without time zone" | "timestamp with time zone" => match dt_prec {
            Some(p) if p > 0 => format!("datetime({p})"),
            _ => "datetime".into(),
        },
        "date" => "date".into(),
        "time without time zone" | "time with time zone" => "time".into(),
        "bytea" => "blob".into(),
        "json" | "jsonb" => "jsontext".into(),
        "inet" => "varbinary(16)".into(),
        "text" => "text".into(),
        _ => udt.to_owned(),
    }
}

/// A PostgreSQL default without its cast suffix.
pub fn pg_default_text(d: &str) -> String {
    let d = match d.find("::") {
        Some(i) if i > 0 => &d[..i],
        _ => d,
    };
    let d = d.trim_matches('\'');
    match d.to_lowercase().as_str() {
        "now()" | "current_timestamp" => "CURRENT_TIMESTAMP".into(),
        "true" => "1".into(),
        "false" => "0".into(),
        _ => d.to_owned(),
    }
}

fn sqlite_ident_byte(b: u8) -> bool {
    b == b'_' || b.is_ascii_alphanumeric()
}

/// The index of the parenthesis that closes the one at `start`.
pub fn sqlite_balanced_paren(s: &[u8], start: usize) -> Result<usize, String> {
    let mut depth = 0i32;
    let mut i = start;
    while i < s.len() {
        match s[i] {
            q @ (b'\'' | b'"' | b'`') => {
                i += 1;
                while i < s.len() && s[i] != q {
                    i += 1;
                }
                if i >= s.len() {
                    return Err("unterminated quoted value".into());
                }
            }
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Ok(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    Err("unbalanced parentheses".into())
}

/// The CHECK constraints of a SQLite CREATE TABLE statement.
/// Whether a SQLite column default is the one the DDL writes for `=now`.
pub fn sqlite_clock_default(def: &str) -> bool {
    let mut def = def.trim();
    while def.len() > 1 && def.starts_with('(') && def.ends_with(')') {
        def = def[1..def.len() - 1].trim();
    }
    def.eq_ignore_ascii_case("CURRENT_TIMESTAMP") || def == "strftime('%Y-%m-%d %H:%M:%f', 'now') || '000'"
}

/// Whether the CREATE TABLE text declares `column` as INTEGER PRIMARY KEY
/// AUTOINCREMENT.
pub fn sqlite_auto_increment(create_sql: &str, column: &str) -> bool {
    let upper = create_sql.to_uppercase();
    let fields: Vec<&str> = upper.split_whitespace().collect();
    let column = column.to_uppercase();
    let names = [format!("\"{column}\""), format!("`{column}`"), column.clone(), format!("[{column}]")];
    fields.windows(5).any(|w| {
        let name = w[0].trim_start_matches(['(', ',']);
        names.iter().any(|n| n == name) && w[1] == "INTEGER" && w[2] == "PRIMARY" && w[3] == "KEY" && w[4].trim_end_matches([',', ')']) == "AUTOINCREMENT"
    })
}

pub fn sqlite_checks(table: &str, create_sql: &str) -> Result<Vec<Check>, String> {
    let s = create_sql.as_bytes();
    let mut checks = Vec::new();
    let mut i = 0;
    while i < s.len() {
        if let q @ (b'\'' | b'"' | b'`') = s[i] {
            i += 1;
            while i < s.len() {
                if s[i] == q {
                    if i + 1 < s.len() && s[i + 1] == q {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            i += 1;
            continue;
        }
        let is_check = i + 5 <= s.len()
            && s[i..i + 5].eq_ignore_ascii_case(b"CHECK")
            && !(i > 0 && sqlite_ident_byte(s[i - 1]))
            && !(i + 5 < s.len() && sqlite_ident_byte(s[i + 5]));
        if !is_check {
            i += 1;
            continue;
        }
        let mut j = i + 5;
        while j < s.len() && b" \t\r\n".contains(&s[j]) {
            j += 1;
        }
        if j >= s.len() || s[j] != b'(' {
            return Err(format!("table {table}: sqlite CHECK expression missing opening parenthesis"));
        }
        let end = sqlite_balanced_paren(s, j).map_err(|e| format!("table {table}: sqlite CHECK expression: {e}"))?;
        let mut name = format!("check_{table}_{}", checks.len() + 1);
        let prefix = create_sql[..i].trim();
        if let Some(k) = prefix.to_uppercase().rfind("CONSTRAINT ") {
            let candidate = prefix[k + "CONSTRAINT ".len()..].trim();
            if !candidate.is_empty() && !candidate.contains([' ', ',', '(', ')', '\t', '\r', '\n']) {
                name = candidate.trim_matches(['`', '"']).to_owned();
            }
        }
        checks.push(Check { name, expr: create_sql[j + 1..end].trim().to_owned() });
        i = end + 1;
    }
    Ok(checks)
}
