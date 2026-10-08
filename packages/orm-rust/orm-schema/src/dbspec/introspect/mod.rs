//! Introspection (docs/dialects.md, "Introspection"): the fixed catalog
//! queries of each dialect and the reading of their rows into one dbspec
//! document and the objects it cannot express. The client that owns the
//! connection runs [`catalog_queries`] in order and passes their rows to
//! [`read_catalog`].

mod check;
mod mysql;
mod postgres;
mod sqlite;
mod trigger;

use super::model::{Document, Type};
use super::render::Dialect;
use std::collections::BTreeMap;
use std::fmt;

/// catalog query 결과의 값 하나. driver가 돌려준 type 그대로이며, reader가
/// 기대한 type이 아니면 error다.
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

/// The introspected document and the unsupported objects ordered by table,
/// kind and name.
#[derive(Clone, Debug)]
pub struct Introspection {
    pub document: Document,
    pub unsupported: Vec<Unsupported>,
}

/// The catalog queries of `dialect` in the order [`read_catalog`] expects
/// their rows. Every query reads all tables at once, so their number does not
/// depend on the table count.
pub fn catalog_queries(dialect: Dialect) -> &'static [&'static str] {
    match dialect {
        Dialect::MySql => &mysql::QUERIES,
        Dialect::Postgres => &postgres::QUERIES,
        Dialect::Sqlite => &sqlite::QUERIES,
    }
}

/// Reads the rows of the [`catalog_queries`] of `dialect`, one result per
/// query in order, into the document `name` and its unsupported objects. A
/// result count that differs from the query count, a value of an unexpected
/// type, and a document that cannot be built are errors.
pub fn read_catalog(dialect: Dialect, results: &[Vec<Vec<CatalogValue>>], name: &str) -> Result<Introspection, String> {
    let queries = catalog_queries(dialect);
    if results.len() != queries.len() {
        return Err(format!("{} catalog results for {} queries", results.len(), queries.len()));
    }
    let results = Results { results };
    let catalog = match dialect {
        Dialect::MySql => mysql::read(&results)?,
        Dialect::Postgres => postgres::read(&results)?,
        Dialect::Sqlite => sqlite::read(&results)?,
    };
    catalog.document(name)
}

/// query 순서대로 받은 catalog 결과.
struct Results<'r> {
    results: &'r [Vec<Vec<CatalogValue>>],
}

impl<'r> Results<'r> {
    /// query index의 row들.
    fn rows(&self, query: usize) -> impl Iterator<Item = Row<'r>> {
        self.results[query].iter().map(move |values| Row { query, values })
    }
}

/// catalog row 하나. accessor는 기대한 type이 아닌 값을 error로 보고한다.
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

    /// boolean 값. MySQL은 `IS NOT NULL` 결과를 정수 0과 1로 돌려준다.
    fn flag(&self, i: usize) -> Result<bool, String> {
        match self.value(i)? {
            CatalogValue::Bool(b) => Ok(*b),
            CatalogValue::Int(0) => Ok(false),
            CatalogValue::Int(1) => Ok(true),
            other => Err(self.unexpected(i, "boolean", other)),
        }
    }
}

/// dialect reader가 채우는 중립 중간 model. type은 dbspec Type이고, default
/// literal과 predicate는 이미 dbspec 표기다.
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

    /// column 이름과 type. check는 literal을 그것이 만나는 column의 값으로 읽는다.
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

/// dbspec text 한 줄이 나타내는 객체. kind는 Unsupported의 kind다.
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

    /// type이 정해지지 않은 column을 뺀다.
    fn drop_column(&mut self, table: &str, column: &str) {
        if let Some(t) = self.table(table) {
            t.columns.retain(|c| c.name != column);
        }
    }

    /// 중간 model을 dbspec text로 쓰고 parse한다. parse가 어떤 줄을 거부하면 그
    /// 줄의 객체를 미지원으로 보고하고 빼서 다시 만든다. 빠진 객체를 참조하던
    /// 객체는 다음 parse에서 거부되므로 같은 방식으로 빠진다. 객체에 속하지 않는
    /// 줄의 diagnostic은 reader의 결함이므로 error다.
    pub(super) fn document(mut self, name: &str) -> Result<Introspection, String> {
        self.drop_tables_without_key();
        loop {
            let (text, objects) = self.text(name);
            let diagnostics = match super::parse(&text, &BTreeMap::new()) {
                Ok(document) => {
                    self.unsupported.sort_by(|a, b| (&a.table, &a.kind, &a.name).cmp(&(&b.table, &b.kind, &b.name)));
                    return Ok(Introspection { document, unsupported: self.unsupported });
                }
                Err(diagnostics) => diagnostics,
            };
            // 거부된 table의 객체는 table과 함께 빠지므로 따로 보고하지 않는다.
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

    /// 객체 하나를 뺀다. table이나 primary key를 빼면 table 전체가 빠진다.
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

    /// primary key가 없는 table을 뺀다. 그 table을 참조하던 foreign key는 parse가
    /// 거부해 빠진다.
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

    /// table을 이름 순으로 쓴 dbspec text와, 줄 번호마다 그 줄의 객체를 돌려준다.
    /// 닫는 괄호와 primary key 줄은 table에 속한다.
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

/// catalog의 참조 action을 dbspec action으로 바꾼다.
fn action_name(rule: &str) -> Option<&'static str> {
    match rule.to_uppercase().as_str() {
        "RESTRICT" => Some("restrict"),
        "CASCADE" => Some("cascade"),
        "SET NULL" => Some("set_null"),
        _ => None,
    }
}

/// renderer CHECK의 이름 `<table>$<column>`.
fn renderer_check_name(table: &str, column: &str) -> String {
    format!("{table}${column}")
}

/// 정규식 capture group의 text. 참여하지 않은 group은 빈 문자열이다.
fn group<'t>(captures: &regex::Captures<'t>, i: usize) -> &'t str {
    captures.get(i).map_or("", |m| m.as_str())
}
