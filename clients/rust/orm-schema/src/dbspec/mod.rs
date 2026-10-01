//! dbspec, the schema language (`docs/dbspec.md`): parsing with every
//! validation rule, and canonical emission.
//!
//! [`parse`] reads one document against the declared document set that its
//! `use` lines refer to and returns the [`Document`] or every [`Diagnostic`]
//! in source order. [`emit`] writes a document in its canonical text, so
//! `emit(parse(s)) == s` for canonical input.

mod check;
mod emit;
mod lexer;
mod literal;
mod model;
mod parser;
mod validate;

pub use model::Document;

use parser::Diag;
use std::collections::{BTreeMap, HashMap};
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
    let parsed = parser::parse(text).map_err(diagnostics)?;
    let name = parsed.document.name.text.clone();
    let diags = session.validate(&name, &parsed);
    if diags.is_empty() {
        Ok(parsed.document)
    } else {
        Err(diagnostics(diags))
    }
}

/// Writes `document` in its canonical text.
pub fn emit(document: &Document) -> String {
    emit::emit(document)
}

fn diagnostics(mut diags: Vec<Diag>) -> Vec<Diagnostic> {
    diags.sort_by_key(|d| d.pos);
    diags.into_iter().map(|d| Diagnostic { rule: d.rule.to_owned(), line: d.pos.line, column: d.pos.column, message: d.message }).collect()
}

/// Resolves used documents of one `parse` call. A used document is parsed once
/// and validated once; a document that is being validated counts as valid where
/// `use` lines refer back to it, so documents may use each other.
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
        if self.validating.iter().any(|n| n == name) {
            return Ok(());
        }
        if let Some(result) = self.valid.get(name) {
            return result.clone();
        }
        let parsed = self.parsed(name)?;
        let diags = self.validate(name, &parsed);
        let result = if diags.is_empty() { Ok(()) } else { Err(invalid(name, diags)) };
        self.valid.insert(name.to_owned(), result.clone());
        result
    }

    /// The line errors of `parsed` and its validation errors, unsorted.
    fn validate(&mut self, name: &str, parsed: &parser::Parsed) -> Vec<Diag> {
        self.validating.push(name.to_owned());
        let mut diags = parsed.diags.clone();
        let mut used = Vec::with_capacity(parsed.document.uses.len());
        for line in &parsed.document.uses {
            let document = &line.document;
            let resolved = self.parsed(&document.text).and_then(|other| self.valid(&document.text).map(|_| other));
            match resolved {
                Ok(other) => used.push(Some(other)),
                Err(message) => {
                    diags.push(Diag { pos: document.pos, rule: "use", message });
                    used.push(None);
                }
            }
        }
        let used: Vec<Option<&Document>> = used.iter().map(|u| u.as_ref().map(|p| &p.document)).collect();
        validate::validate(&parsed.document, &parsed.unresolved, &used, &mut diags);
        self.validating.pop();
        diags
    }
}

fn invalid(name: &str, mut diags: Vec<Diag>) -> String {
    diags.sort_by_key(|d| d.pos);
    let first = diags.first().map_or(String::new(), |d| format!(": {}:{} {}: {}", d.pos.line, d.pos.column, d.rule, d.message));
    format!("document '{name}' is invalid{first}")
}
