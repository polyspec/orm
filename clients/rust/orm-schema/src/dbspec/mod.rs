//! dbspec, the schema language (`docs/dbspec.md`): parsing with every
//! validation rule, and canonical emission.
//!
//! [`read_file`] reads a document file after checking its signature, and [`read_bytes`]
//! checks the bytes of a file that the caller read.
//! [`parse`] reads one document against the declared document set that its
//! `use` lines refer to and returns the [`Document`] or every [`Diagnostic`]
//! in source order. [`emit`] writes a document in its canonical text, so
//! `emit(parse(s)) == s` for canonical input.

mod add_tables_and_columns;
mod check;
mod check_type;
mod compare;
mod emit;
mod file;
mod introspect;
mod lexer;
mod literal;
mod mermaid;
pub mod model;
mod parser;
mod plan;
mod plan_diff;
mod plan_objects;
mod plan_steps;
mod render;
mod runtime;
mod validate;

pub use add_tables_and_columns::{add_tables_and_columns_steps, AddTablesAndColumnsSteps};
pub use compare::{compare_schemas, Difference, RULE_COMPARE};
pub use file::{read_bytes, read_file, ReadError, SIGNATURE};
pub use introspect::{catalog_queries, read_catalog, CatalogValue, Introspection, Unsupported};
pub use mermaid::{export_mermaid, import_mermaid, RULE_MERMAID};
pub use model::{Document, Type};
pub use plan::{chain, emit_plan, parse_plan, ColumnName, ColumnRename, Plan, TableRename, RULE_CHAIN, RULE_PLAN};
pub use plan_diff::{diff, Change};
pub use plan_steps::{plan_steps, Effect, NullCheck, PlanStep};
pub use render::{render, Dialect};
pub use runtime::{parse_manifest, parse_manifest_set, runtime_model, Audit, Entity, Field, FieldDefault, ForeignKey, Key, RuntimeModel};

use parser::Diag;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::rc::Rc;

/// One `SCHEMA_INVALID` error: the rule of `docs/dbspec.md` that the document
/// breaks, the 1-based line and character column of the offending token, and a
/// message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub rule: String,
    pub line: usize,
    pub column: usize,
    pub message: String,
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SCHEMA_INVALID {}:{} {}: {}", self.line, self.column, self.rule, self.message)
    }
}

impl std::error::Error for Diagnostic {}

/// Parses `text` and validates it. `documents` is the declared document set:
/// document name to text, where `use` lines find the documents they name.
/// Returns the document, or every diagnostic in source order; an `encoding`,
/// `header` or `limit` error ends parsing.
pub fn parse(text: &str, documents: &BTreeMap<String, String>) -> Result<Document, Vec<Diagnostic>> {
    let mut session = Session { documents, parsed: HashMap::new(), valid: HashMap::new(), validating: Vec::new() };
    let parsed = parser::parse(text).map_err(stopped)?;
    let name = parsed.document.name.text.clone();
    let (diags, literals) = session.validate(&name, &parsed);
    if diags.is_empty() {
        let mut document = parsed.document;
        check_type::set_literals(&mut document, literals);
        Ok(document)
    } else {
        Err(diagnostics(diags))
    }
}

/// Writes `document` in its canonical text.
pub fn emit(document: &Document) -> String {
    emit::emit(document, emit::View::Canonical)
}

/// The manifest and schema texts of a document set and their hashes
/// (docs/dbspec.md, "Manifest and hashes").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    pub manifest_text: String,
    /// 외부 문서마다 소유한 문서가 쓰는 table의 column, primary key, unique key만 담은 canonical text다.
    /// 외부 문서가 없으면 비어 있다.
    pub external_text: String,
    pub schema_text: String,
    pub manifest_hash: String,
    pub schema_hash: String,
}

/// `sha256:` and the lower-case hexadecimal SHA-256 of the text.
fn text_hash(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(text.as_bytes());
    let mut out = String::with_capacity(7 + 64);
    out.push_str("sha256:");
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Checks that `documents` is one document set (docs/dbspec.md, "Manifest and
/// hashes") and returns its documents in document name order. A document name
/// that repeats is a `name.duplicate` diagnostic and a used document missing
/// from the set is a `use` diagnostic, both at the header name of the later or
/// the using document; documents are checked in name order and the used names
/// of a document in name order.
pub(crate) fn check_set<'d>(documents: &[&'d Document]) -> Result<Vec<&'d Document>, Vec<Diagnostic>> {
    let mut ordered = documents.to_vec();
    ordered.sort_by(|a, b| a.name.text.cmp(&b.name.text));
    let names: BTreeSet<&str> = ordered.iter().map(|d| d.name.text.as_str()).collect();
    let header = "dbspec 1 ".len() + 1;
    let mut out = Vec::new();
    for (i, document) in ordered.iter().enumerate() {
        let name = &document.name.text;
        if i > 0 && ordered[i - 1].name.text == *name {
            out.push(Diagnostic {
                rule: "name.duplicate".to_owned(),
                line: 1,
                column: header,
                message: format!("document {name} appears twice in the document set"),
            });
        }
        let mut used: Vec<&str> = document.uses.iter().map(|u| u.document.text.as_str()).collect();
        used.sort_unstable();
        for missing in used.into_iter().filter(|u| !names.contains(u)) {
            out.push(Diagnostic {
                rule: "use".to_owned(),
                line: 1,
                column: header,
                message: format!("document {name} uses {missing}, which is not in the document set"),
            });
        }
    }
    // 외부 문서는 소유한 문서에서 use를 따라 닿는 문서다.
    let mut reached: BTreeSet<&str> = BTreeSet::new();
    let mut pending: Vec<&Document> = ordered.iter().copied().filter(|d| !d.external).collect();
    while let Some(document) = pending.pop() {
        for line in &document.uses {
            if let Some(next) = ordered.iter().find(|d| d.name.text == line.document.text) {
                if reached.insert(next.name.text.as_str()) {
                    pending.push(next);
                }
            }
        }
    }
    for document in ordered.iter().filter(|d| d.external && !reached.contains(d.name.text.as_str())) {
        out.push(Diagnostic {
            rule: "use".to_owned(),
            line: 1,
            column: header,
            message: format!("external document {} is not used by a document of the set", document.name.text),
        });
    }
    if out.is_empty() {
        Ok(ordered)
    } else {
        Err(out)
    }
}

/// Returns the manifest of the document set, whose documents are taken in
/// document name order, or the diagnostics of an invalid document set:
/// repeated document names and used documents missing from the set.
pub fn manifest(documents: &[&Document]) -> Result<Manifest, Vec<Diagnostic>> {
    let ordered = check_set(documents)?;
    // 외부 문서마다 소유한 문서가 use로 쓰는 table이다. 처음 나온 순서를 지킨다.
    let mut used: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for document in ordered.iter().filter(|d| !d.external) {
        for line in &document.uses {
            let tables = used.entry(line.document.text.as_str()).or_default();
            for table in &line.tables {
                if !tables.contains(&table.text.as_str()) {
                    tables.push(&table.text);
                }
            }
        }
    }
    let mut manifest_text = String::new();
    let mut external_text = String::new();
    let mut uses = Vec::new();
    for document in &ordered {
        if document.external {
            let tables = used.get(document.name.text.as_str()).cloned().unwrap_or_default();
            if let Some(trimmed) = external_document(document, &tables) {
                external_text.push_str(&emit::emit(&trimmed, emit::View::Manifest));
                let mut names = tables.clone();
                names.sort_unstable();
                uses.push(model::Use {
                    comments: Vec::new(),
                    document: document.name.clone(),
                    tables: names.into_iter().map(|t| model::Name { text: t.to_owned(), pos: Default::default() }).collect(),
                });
            }
            continue;
        }
        manifest_text.push_str(&emit::emit(document, emit::View::Manifest));
    }
    // schema text는 집합이 소유한 모든 table을 이름 순으로 담은 문서 `schema` 하나이므로 문서를 나누는 방식과
    // 무관하다. 외부 문서에서 쓰는 table은 그 문서의 use 줄로 남는다.
    let mut tables: Vec<model::Table> = ordered.iter().filter(|d| !d.external).flat_map(|d| d.tables.iter().cloned()).collect();
    tables.sort_by(|a, b| a.name.text.cmp(&b.name.text));
    let schema = Document {
        name: model::Name { text: "schema".to_owned(), pos: Default::default() },
        uses,
        tables,
        diagrams: Vec::new(),
        trailing: Vec::new(),
        external: false,
    };
    let schema_text = emit::emit(&schema, emit::View::Schema);
    let manifest_hash = text_hash(&format!("{manifest_text}{external_text}"));
    let schema_hash = text_hash(&schema_text);
    Ok(Manifest { manifest_text, external_text, schema_text, manifest_hash, schema_hash })
}

/// 외부 문서에서 `tables`의 column, primary key, unique key만 문서 순서로 담은 문서다. 그 table이 없으면
/// None이다. foreign key, index, check, setting과 주석은 외부 문서가 소유하므로 담지 않는다.
fn external_document(document: &Document, tables: &[&str]) -> Option<Document> {
    let kept: Vec<model::Table> = document
        .tables
        .iter()
        .filter(|t| tables.contains(&t.name.text.as_str()))
        .map(|t| model::Table {
            comments: Vec::new(),
            name: t.name.clone(),
            columns: t.columns.iter().map(|c| model::Column { comments: Vec::new(), ..c.clone() }).collect(),
            primary: t.primary.iter().map(|k| model::PrimaryKey { comments: Vec::new(), ..k.clone() }).collect(),
            uniques: t.uniques.iter().map(|u| model::Unique { comments: Vec::new(), ..u.clone() }).collect(),
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            checks: Vec::new(),
            settings: None,
            closing: Vec::new(),
        })
        .collect();
    if kept.is_empty() {
        return None;
    }
    Some(Document { name: document.name.clone(), uses: Vec::new(), tables: kept, diagrams: Vec::new(), trailing: Vec::new(), external: true })
}

/// set이 외부 문서에서 쓰는 table이 database에 있는지 확인한다(docs/dbspec.md "External documents").
/// `live`는 database를 introspect한 문서다. 쓰는 table마다 table이 없거나, 외부 문서의 column이 없거나 type이나
/// null이 다르거나, primary key가 다르거나, unique key의 column 목록이 없으면 그 차이를 table, column 순으로
/// 돌려준다. 외부 문서가 없으면 빈 목록이다.
pub fn external_differences(live: &Document, documents: &[&Document]) -> Vec<String> {
    let mut tables: Vec<&model::Table> = Vec::new();
    for document in documents.iter().filter(|d| !d.external) {
        for line in &document.uses {
            let Some(external) = documents.iter().find(|d| d.external && d.name.text == line.document.text) else { continue };
            for name in &line.tables {
                if let Some(table) = external.tables.iter().find(|t| t.name.text == name.text) {
                    if !tables.iter().any(|t| t.name.text == name.text) {
                        tables.push(table);
                    }
                }
            }
        }
    }
    tables.sort_by(|a, b| a.name.text.cmp(&b.name.text));
    let keys = |t: &model::Table| -> Vec<String> { t.primary.first().map(|k| k.columns.iter().map(|c| c.text.clone()).collect()).unwrap_or_default() };
    let null_text = |null: bool| if null { "null" } else { "not null" };
    let mut out = Vec::new();
    for want in tables {
        let name = &want.name.text;
        let Some(got) = live.tables.iter().find(|t| t.name.text == *name) else {
            out.push(format!("table {name} does not exist"));
            continue;
        };
        for c in &want.columns {
            match got.columns.iter().find(|g| g.name.text == c.name.text) {
                None => out.push(format!("column {name}.{} does not exist", c.name.text)),
                Some(g) if g.ty.render() != c.ty.render() => out.push(format!("column {name}.{} is {}, not {}", c.name.text, g.ty.render(), c.ty.render())),
                Some(g) if g.nullable != c.nullable => {
                    out.push(format!("column {name}.{} is {}, not {}", c.name.text, null_text(g.nullable), null_text(c.nullable)))
                }
                Some(_) => {}
            }
        }
        let (got_keys, want_keys) = (keys(got), keys(want));
        if got_keys != want_keys {
            out.push(format!("table {name} has the primary key ({}), not ({})", got_keys.join(", "), want_keys.join(", ")));
        }
        for unique in &want.uniques {
            let columns: Vec<&str> = unique.columns.iter().map(|c| c.text.as_str()).collect();
            if !got.uniques.iter().any(|g| g.columns.iter().map(|c| c.text.as_str()).eq(columns.iter().copied())) {
                out.push(format!("table {name} has no unique key ({})", columns.join(", ")));
            }
        }
    }
    out
}

/// The rules in the order of the rule table of docs/dbspec.md, which orders
/// diagnostics at one position.
const RULES: [&str; 16] = [
    "header",
    "syntax",
    "order",
    "name.format",
    "name.length",
    "name.duplicate",
    "type",
    "column",
    "key",
    "foreign_key",
    "check",
    "setting",
    "use",
    "diagram",
    "limit",
    "encoding",
];

fn sort(diags: &mut [Diag]) {
    diags.sort_by_key(|d| (d.pos, RULES.iter().position(|r| *r == d.rule)));
}

/// The diagnostics of a stopped parse: those found before the stopping error,
/// in order, then the stopping error.
fn stopped(mut diags: Vec<Diag>) -> Vec<Diagnostic> {
    let stop = diags.pop();
    sort(&mut diags);
    diags.extend(stop);
    convert(diags)
}

fn diagnostics(mut diags: Vec<Diag>) -> Vec<Diagnostic> {
    sort(&mut diags);
    convert(diags)
}

fn convert(diags: Vec<Diag>) -> Vec<Diagnostic> {
    diags.into_iter().map(|d| Diagnostic { rule: d.rule.to_owned(), line: d.pos.line, column: d.pos.column, message: d.message }).collect()
}

/// Resolves used documents of one `parse` call. A used document is parsed once
/// and validated once with its own `use` lines; using the document itself or
/// any use cycle is a `use` error.
struct Session<'s> {
    documents: &'s BTreeMap<String, String>,
    parsed: HashMap<String, Result<Rc<parser::Parsed>, String>>,
    valid: HashMap<String, Result<(), String>>,
    validating: Vec<String>,
}

impl<'s> Session<'s> {
    /// The parsed document of the declared set named `name`.
    fn parsed(&mut self, name: &str) -> Result<Rc<parser::Parsed>, String> {
        if let Some(found) = self.parsed.get(name) {
            return found.clone();
        }
        let result = match self.documents.get(name) {
            None => Err(format!("document '{name}' is not in the declared document set")),
            Some(text) => match parser::parse(text) {
                Err(stopped) => Err(invalid(name, stopped)),
                Ok(parsed) if parsed.document.name.text != name => {
                    Err(format!("the declared document '{name}' has the header name '{}'", parsed.document.name.text))
                }
                Ok(parsed) => Ok(Rc::new(parsed)),
            },
        };
        self.parsed.insert(name.to_owned(), result.clone());
        result
    }

    /// Validates the declared document `name` once.
    fn valid(&mut self, name: &str) -> Result<(), String> {
        if let Some(result) = self.valid.get(name) {
            return result.clone();
        }
        let parsed = self.parsed(name)?;
        let (diags, _) = self.validate(name, &parsed);
        let result = if diags.is_empty() { Ok(()) } else { Err(invalid(name, diags)) };
        self.valid.insert(name.to_owned(), result.clone());
        result
    }

    /// The line errors of `parsed` and its validation errors, unsorted, with
    /// the canonical literal texts of its checks.
    fn validate(&mut self, name: &str, parsed: &parser::Parsed) -> (Vec<Diag>, Vec<check_type::CheckLiterals>) {
        self.validating.push(name.to_owned());
        let mut diags = parsed.diags.clone();
        let mut used = Vec::with_capacity(parsed.document.uses.len());
        for line in &parsed.document.uses {
            let document = &line.document;
            if !parser::well_formed(&document.text) {
                used.push(None);
                continue;
            }
            let resolved = if document.text == name {
                Err(format!("document '{name}' uses itself"))
            } else if self.validating.contains(&document.text) {
                Err(format!("document '{}' is part of a use cycle: {} -> {}", document.text, self.validating.join(" -> "), document.text))
            } else {
                self.parsed(&document.text).and_then(|other| self.valid(&document.text).map(|_| other))
            };
            match resolved {
                Ok(other) => used.push(Some(other)),
                Err(message) => {
                    diags.push(Diag { pos: document.pos, rule: "use", message });
                    used.push(None);
                }
            }
        }
        let used: Vec<Option<&Document>> = used.iter().map(|u| u.as_ref().map(|p| &p.document)).collect();
        let mut literals = Vec::new();
        validate::validate(&parsed.document, &parsed.unresolved, &parsed.failed_keys, &used, &mut diags, &mut literals);
        self.validating.pop();
        (diags, literals)
    }
}

fn invalid(name: &str, mut diags: Vec<Diag>) -> String {
    sort(&mut diags);
    let first = diags.first().map_or(String::new(), |d| format!(": {}:{} {}: {}", d.pos.line, d.pos.column, d.rule, d.message));
    format!("document '{name}' is invalid{first}")
}
