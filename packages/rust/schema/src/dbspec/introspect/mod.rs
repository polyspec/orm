//! Introspection (docs/spec/dialects.md, "Introspection"): the fixed catalog
//! queries of each dialect and the reading of their rows into one dbspec
//! document and the objects it cannot express. The client that owns the
//! connection runs [`catalog_queries`] in order, then the [`catalog_followups`]
//! of their rows, and passes all rows to [`read_catalog`].

macro_rules! lazy_pattern {
    ($pattern:literal, $label:literal) => {
        std::sync::LazyLock::new(|| super::compile_pattern($pattern, $label))
    };
}
pub(super) use lazy_pattern;

mod check;
mod mysql;
mod postgres;
mod sqlite;
mod trigger;

use super::model::{Document, Type};
use super::render::Dialect;
use regex::Regex;
use std::collections::BTreeMap;
use std::fmt;

/// One value of a catalog query result, with the type the driver returned unchanged; the reader
/// is an error if it is not the expected type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CatalogValue {
    Null,
    Text(String),
    Int(i64),
    Bool(bool),
}

/// An object that introspection cannot read into dbspec: `kind` is one of
/// column, index, unique, foreign_key, check, trigger, view, routine,
/// sequence, event, partition and table; `table` is empty for an object
/// without a table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unsupported {
    pub kind: String,
    pub table: String,
    pub name: String,
    pub reason: String,
}

/// The reason of the unsupported column of a uuid in the text storage of a release up to 0.0.28, or of a conversion that
/// stopped (DIA-144), which dbspec apply converts to 16 bytes (PLN-108). The column stays in the document as a uuid.
pub const TEXT_STORAGE_REASON: &str = "uuid stored as text by an earlier release; dbspec apply converts it to 16 bytes";

/// The lower-case canonical text of the 16 bytes `b` of a uuid (DIA-27): two hex digits a byte, in order, with a hyphen
/// before the bytes 4, 6, 8 and 10.
pub fn uuid_text(b: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(36);
    for (i, x) in b.iter().enumerate() {
        if matches!(i, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        out.push(char::from(DIGITS[usize::from(x >> 4)]));
        out.push(char::from(DIGITS[usize::from(x & 15)]));
    }
    out
}

/// The bytes of the hex digits `text`, two digits to a byte, or `None` when `text` is not hex digits in pairs.
pub fn hex_bytes(text: &str) -> Option<Vec<u8>> {
    let digits = text.as_bytes();
    if !digits.len().is_multiple_of(2) {
        return None;
    }
    digits.chunks(2).map(|pair| Some(hex_digit(pair[0])? << 4 | hex_digit(pair[1])?)).collect()
}

/// The value of one hex digit of either case.
fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// The introspected document and the unsupported objects ordered by table,
/// kind and name.
#[derive(Clone, Debug)]
pub struct Introspection {
    pub document: Document,
    pub unsupported: Vec<Unsupported>,
}

/// The database server that a connection reached (DIA-200): MySQL and MariaDB are the servers of the mysql dialect,
/// PostgreSQL and SQLite each the server of its own. Its name prints as `mysql`, `mariadb`, `postgres` and `sqlite`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Server {
    MySql,
    MariaDb,
    Postgres,
    Sqlite,
}

impl Server {
    /// The name of the server: `mysql`, `mariadb`, `postgres` or `sqlite`.
    pub fn name(self) -> &'static str {
        match self {
            Server::MySql => "mysql",
            Server::MariaDb => "mariadb",
            Server::Postgres => "postgres",
            Server::Sqlite => "sqlite",
        }
    }

    /// The dialect of the server.
    pub fn dialect(self) -> Dialect {
        match self {
            Server::MySql | Server::MariaDb => Dialect::MySql,
            Server::Postgres => Dialect::Postgres,
            Server::Sqlite => Dialect::Sqlite,
        }
    }
}

impl fmt::Display for Server {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// The name of a dialect, as a refusal names it.
fn dialect_name(dialect: Dialect) -> &'static str {
    match dialect {
        Dialect::MySql => "mysql",
        Dialect::Postgres => "postgres",
        Dialect::Sqlite => "sqlite",
    }
}

/// Refuses a server that is not a server of `dialect` (DBS-174, DIA-203): a programming error, so it panics with a message
/// that names the server. Dialect is an enum, so no unknown dialect reaches it.
///
/// # Panics
///
/// When `server` is not a server of `dialect`.
pub fn check_server(dialect: Dialect, server: Server) {
    if server.dialect() != dialect {
        panic!("dbspec: server {server} is not a server of the dialect {}", dialect_name(dialect));
    }
}

/// MariaDB's COLUMN_DEFAULT as the table descriptor of a catalog connection reads it (DIA-205): the default in the MySQL
/// form, None for `NULL`, and whether it is an expression default as MySQL marks it. A quoted text that is not one whole
/// literal is an error.
pub fn mariadb_catalog_default(dflt: Option<String>) -> Result<(Option<String>, bool), String> {
    mysql::mariadb_catalog_default(dflt)
}

/// The catalog queries of `dialect` on `server` in the order [`read_catalog`] expects
/// their rows. Every query reads all tables at once, so their number does not
/// depend on the table count. The caller passes the server that the connection read
/// when it connected (DIA-203); no query reads a version.
///
/// # Panics
///
/// When `server` is not a server of `dialect` ([`check_server`]).
pub fn catalog_queries(dialect: Dialect, server: Server) -> &'static [&'static str] {
    check_server(dialect, server);
    match dialect {
        Dialect::MySql => mysql::queries(server),
        Dialect::Postgres => &postgres::QUERIES,
        Dialect::Sqlite => &sqlite::QUERIES,
    }
}

/// The follow-up queries of `dialect` on `server`, given the rows of its [`catalog_queries`]:
/// queries whose text depends on those rows, which the client runs after the
/// catalog queries in this order. Their rows follow the catalog rows in the
/// slice that [`read_catalog`] reads. MySQL reads the `SHOW CREATE TABLE` of a
/// table whose CHECK_CLAUSE holds non-ASCII text; the other dialects have none.
///
/// # Panics
///
/// When `server` is not a server of `dialect` ([`check_server`]).
pub fn catalog_followups(dialect: Dialect, server: Server, results: &[Vec<Vec<CatalogValue>>]) -> Result<Vec<String>, String> {
    let queries = catalog_queries(dialect, server);
    if results.len() != queries.len() {
        return Err(format!("{} catalog results for {} queries", results.len(), queries.len()));
    }
    let results = Results { results };
    match dialect {
        Dialect::MySql => mysql::followups(&results, server),
        Dialect::Postgres | Dialect::Sqlite => Ok(Vec::new()),
    }
}

/// Reads the rows of the [`catalog_queries`] of `dialect` on `server`, one result per
/// query in order, followed by the rows of the [`catalog_followups`] in
/// order, into the document `name` and its unsupported objects. A result
/// count that differs from the query and follow-up count, a value of an
/// unexpected type, and a document that cannot be built are errors.
///
/// # Panics
///
/// When `server` is not a server of `dialect` ([`check_server`]).
pub fn read_catalog(dialect: Dialect, server: Server, results: &[Vec<Vec<CatalogValue>>], name: &str) -> Result<Introspection, String> {
    let queries = catalog_queries(dialect, server);
    if results.len() < queries.len() {
        return Err(format!("{} catalog results for {} queries", results.len(), queries.len()));
    }
    let followups = catalog_followups(dialect, server, &results[..queries.len()])?;
    if results.len() != queries.len() + followups.len() {
        return Err(format!("{} catalog results for {} queries and {} follow-up queries", results.len(), queries.len(), followups.len()));
    }
    let results = Results { results };
    let catalog = match dialect {
        Dialect::MySql => mysql::read(&results, server)?,
        Dialect::Postgres => postgres::read(&results)?,
        Dialect::Sqlite => sqlite::read(&results)?,
    };
    catalog.document(name)
}

/// Parses a nullable catalog default while retaining the original text for an unsupported-value diagnostic.
fn parse_column_default(text: Option<String>, parse: impl FnOnce(&str) -> Option<String>) -> std::result::Result<Option<String>, String> {
    text.map(|value| parse(&value).ok_or(value)).transpose()
}

pub(super) fn compile_pattern(pattern: &'static str, label: &'static str) -> Regex {
    Regex::new(pattern).expect(label)
}

fn apply_column_default(
    catalog: &mut Catalog,
    column: &mut IColumn,
    table: &str,
    name: &str,
    text: Option<String>,
    parse: impl FnOnce(&str) -> Option<String>,
) -> bool {
    match parse_column_default(text, parse) {
        Ok(Some(value)) => column.dflt = value,
        Ok(None) => {}
        Err(text) => {
            catalog.report("column", table, name, format!("default {text} is not a dbspec default"));
            return false;
        }
    }
    true
}

/// Catalog results received in query order.
struct Results<'r> {
    results: &'r [Vec<Vec<CatalogValue>>],
}

impl<'r> Results<'r> {
    /// The rows of a query index.
    fn rows(&self, query: usize) -> impl Iterator<Item = Row<'r>> {
        self.results[query].iter().map(move |values| Row { query, values })
    }

    /// The number of results received (the catalog query and follow-up queries).
    fn count(&self) -> usize {
        self.results.len()
    }
}

/// One catalog row. An accessor reports a value of an unexpected type as an error.
struct Row<'r> {
    query: usize,
    values: &'r [CatalogValue],
}

impl Row<'_> {
    fn value(&self, i: usize) -> Result<&CatalogValue, String> {
        self.values.get(i).ok_or_else(|| format!("catalog query {} has no value {i}", self.query))
    }

    fn unexpected(&self, i: usize, want: &str, got: &CatalogValue) -> String {
        format!("catalog query {} value {i}: expected {want}, got {got:?}", self.query)
    }

    fn text(&self, i: usize) -> Result<String, String> {
        match self.value(i)? {
            CatalogValue::Text(s) => Ok(s.clone()),
            other => Err(self.unexpected(i, "text", other)),
        }
    }

    fn opt_text(&self, i: usize) -> Result<Option<String>, String> {
        match self.value(i)? {
            CatalogValue::Null => Ok(None),
            CatalogValue::Text(s) => Ok(Some(s.clone())),
            other => Err(self.unexpected(i, "text or null", other)),
        }
    }

    fn int(&self, i: usize) -> Result<i64, String> {
        match self.value(i)? {
            CatalogValue::Int(n) => Ok(*n),
            other => Err(self.unexpected(i, "integer", other)),
        }
    }

    /// A boolean value. MySQL returns the result of `IS NOT NULL` as integer 0 and 1.
    fn flag(&self, i: usize) -> Result<bool, String> {
        match self.value(i)? {
            CatalogValue::Bool(b) => Ok(*b),
            CatalogValue::Int(0) => Ok(false),
            CatalogValue::Int(1) => Ok(true),
            other => Err(self.unexpected(i, "boolean", other)),
        }
    }
}

/// A neutral intermediate model that the dialect reader fills. type is a dbspec Type, and default
/// literals and predicates are already in dbspec notation.
#[derive(Default)]
pub(super) struct Catalog {
    pub(super) tables: Vec<ITable>,
    unsupported: Vec<Unsupported>,
}

#[derive(Clone, Default)]
pub(super) struct ITable {
    pub(super) name: String,
    pub(super) columns: Vec<IColumn>,
    pub(super) primary: Vec<String>,
    uniques: Vec<IKey>,
    pub(super) indexes: Vec<IKey>,
    pub(super) fks: Vec<IForeignKey>,
    checks: Vec<ICheck>,
    settings: Vec<String>,
}

impl ITable {
    pub(super) fn new(name: &str) -> ITable {
        ITable { name: name.to_owned(), ..ITable::default() }
    }

    /// Column name and type. check reads a literal as a value of the column it meets.
    fn types(&self) -> BTreeMap<String, Type> {
        self.columns.iter().map(|c| (c.name.clone(), c.typ)).collect()
    }
}

#[derive(Clone)]
pub(super) struct IColumn {
    pub(super) name: String,
    pub(super) typ: Type,
    pub(super) null: bool,
    pub(super) identity: bool,
    pub(super) dflt: String,
}

#[derive(Clone)]
pub(super) struct IKey {
    pub(super) name: String,
    pub(super) columns: Vec<String>,
    pub(super) desc: Vec<bool>,
}

#[derive(Clone)]
pub(super) struct IForeignKey {
    pub(super) name: String,
    pub(super) columns: Vec<String>,
    pub(super) table: String,
    pub(super) refs: Vec<String>,
    pub(super) on_delete: &'static str,
    pub(super) on_update: &'static str,
}

#[derive(Clone)]
struct ICheck {
    name: String,
    predicate: String,
}

/// The object that one line of dbspec text represents. kind is the kind of Unsupported.
#[derive(Clone, PartialEq, Eq)]
struct LineObject {
    kind: &'static str,
    table: String,
    name: String,
}

impl Catalog {
    pub(super) fn report(&mut self, kind: &str, table: &str, name: &str, reason: impl fmt::Display) {
        self.unsupported.push(Unsupported { kind: kind.to_owned(), table: table.to_owned(), name: name.to_owned(), reason: reason.to_string() });
    }

    pub(super) fn table(&mut self, name: &str) -> Option<&mut ITable> {
        self.tables.iter_mut().find(|t| t.name == name)
    }

    pub(super) fn has_table(&self, name: &str) -> bool {
        self.tables.iter().any(|t| t.name == name)
    }

    /// Drops columns whose type is not determined.
    fn drop_column(&mut self, table: &str, column: &str) {
        if let Some(t) = self.table(table) {
            t.columns.retain(|c| c.name != column);
        }
    }

    /// Writes the intermediate model as dbspec text and parses it. If parse rejects a line,
    /// the object of that line is reported as unsupported, removed, and rebuilt. Objects that referenced the missing object
    /// are rejected by the next parse, so they are removed the same way. A diagnostic on a line that belongs to no object
    /// is a reader defect, so it is an error.
    pub(super) fn document(mut self, name: &str) -> Result<Introspection, String> {
        self.drop_tables_without_key();
        loop {
            let (text, objects) = self.text(name);
            let diagnostics = match super::parse(&text, &BTreeMap::new()) {
                Ok(parsed) => {
                    self.unsupported.sort_by(|a, b| (&a.table, &a.kind, &a.name).cmp(&(&b.table, &b.kind, &b.name)));
                    return Ok(Introspection { document: parsed.document, unsupported: self.unsupported });
                }
                Err(diagnostics) => diagnostics,
            };
            // Objects of a rejected table are removed with the table, so they are not reported separately.
            let mut rejected: Vec<String> = Vec::new();
            for d in &diagnostics {
                let Some(o) = objects.get(&d.line) else {
                    let list: Vec<String> = diagnostics.iter().map(|d| d.to_string()).collect();
                    return Err(format!("introspected document does not parse: {}\n{text}", list.join("; ")));
                };
                if o.kind == "table" {
                    rejected.push(o.table.clone());
                }
            }
            let mut removed: Vec<LineObject> = Vec::new();
            for d in &diagnostics {
                let o = &objects[&d.line];
                if o.kind != "table" && rejected.contains(&o.table) {
                    continue;
                }
                if !removed.contains(o) {
                    removed.push(o.clone());
                    self.report(o.kind, &o.table, &o.name, format!("{}: {}", d.rule, d.message));
                    self.remove(o);
                }
            }
        }
    }

    /// Removes one object. Removing a table or its primary key removes the whole table.
    fn remove(&mut self, o: &LineObject) {
        if o.kind == "table" {
            self.tables.retain(|t| t.name != o.table);
            return;
        }
        let t = self.table(&o.table).expect("an introspected object belongs to a read table");
        match o.kind {
            "column" => t.columns.retain(|x| x.name != o.name),
            "unique" => t.uniques.retain(|x| x.name != o.name),
            "index" => t.indexes.retain(|x| x.name != o.name),
            "foreign_key" => t.fks.retain(|x| x.name != o.name),
            "check" => t.checks.retain(|x| x.name != o.name),
            "trigger" => t.settings.retain(|x| first_word(x) != o.name),
            _ => {}
        }
    }

    /// Removes a table without a primary key. A foreign key that referenced that table is rejected by parse
    /// and removed.
    fn drop_tables_without_key(&mut self) {
        let tables = std::mem::take(&mut self.tables);
        for t in tables {
            if t.primary.is_empty() {
                self.report("table", &t.name, &t.name, "the table has no primary key");
            } else {
                self.tables.push(t);
            }
        }
    }

    /// Returns the dbspec text of the tables in name order, and for each line number, the object on that line.
    /// The closing brace and primary key line belong to the table.
    fn text(&self, name: &str) -> (String, BTreeMap<usize, LineObject>) {
        let mut tables: Vec<&ITable> = self.tables.iter().collect();
        tables.sort_by(|a, b| a.name.cmp(&b.name));
        let mut lines = vec![format!("dbspec 1 {name}")];
        let mut objects = BTreeMap::new();
        let mut add = |lines: &mut Vec<String>, line: String, kind: &'static str, table: &str, name: &str| {
            lines.push(line);
            objects.insert(lines.len(), LineObject { kind, table: table.to_owned(), name: name.to_owned() });
        };
        for t in tables {
            let n = t.name.as_str();
            lines.push(String::new());
            add(&mut lines, format!("table {n} {{"), "table", n, n);
            for col in &t.columns {
                let mut s = format!("  {} {}", col.name, col.typ.render());
                if col.null {
                    s.push_str(" null");
                }
                if col.identity {
                    s.push_str(" identity");
                }
                if !col.dflt.is_empty() {
                    s.push_str(" default ");
                    s.push_str(&col.dflt);
                }
                add(&mut lines, s, "column", n, &col.name);
            }
            add(&mut lines, format!("  primary key ({})", t.primary.join(", ")), "table", n, n);
            for u in &t.uniques {
                add(&mut lines, format!("  unique {} ({})", u.name, u.columns.join(", ")), "unique", n, &u.name);
            }
            for x in &t.indexes {
                let columns: Vec<String> = x.columns.iter().zip(&x.desc).map(|(c, d)| if *d { format!("{c} desc") } else { c.clone() }).collect();
                add(&mut lines, format!("  index {} ({})", x.name, columns.join(", ")), "index", n, &x.name);
            }
            for f in &t.fks {
                let line = format!(
                    "  foreign key {} ({}) references {} ({}) on delete {} on update {}",
                    f.name,
                    f.columns.join(", "),
                    f.table,
                    f.refs.join(", "),
                    f.on_delete,
                    f.on_update
                );
                add(&mut lines, line, "foreign_key", n, &f.name);
            }
            for k in &t.checks {
                add(&mut lines, format!("  check {} ({})", k.name, k.predicate), "check", n, &k.name);
            }
            if !t.settings.is_empty() {
                add(&mut lines, "  settings {".to_owned(), "table", n, n);
                for s in &t.settings {
                    add(&mut lines, format!("    {s}"), "trigger", n, first_word(s));
                }
                add(&mut lines, "  }".to_owned(), "table", n, n);
            }
            add(&mut lines, "}".to_owned(), "table", n, n);
        }
        (lines.join("\n") + "\n", objects)
    }
}

fn first_word(s: &str) -> &str {
    s.split_whitespace().next().unwrap_or("")
}

/// Converts a catalog reference action to a dbspec action.
fn action_name(rule: &str) -> Option<&'static str> {
    match rule.to_uppercase().as_str() {
        "RESTRICT" => Some("restrict"),
        "CASCADE" => Some("cascade"),
        "SET NULL" => Some("set_null"),
        _ => None,
    }
}

/// The text of a regex capture group. A group that did not participate is an empty string.
fn group<'t>(captures: &regex::Captures<'t>, i: usize) -> &'t str {
    captures.get(i).map_or("", |m| m.as_str())
}

/// The number that a capture holds. A text that is not a number of `T` is an error that names what it was read as.
fn number<T: std::str::FromStr>(text: &str, what: &str) -> Result<T, String>
where
    T::Err: std::fmt::Display,
{
    text.parse().map_err(|error| format!("{what} {} is not a number: {error}", crate::message::quote(text)))
}
