//! The functions of the unit `dbspec` over JSON texts (docs/spec/flowmark-surface.md FMS-20 to FMS-27): a document, a
//! set and their results cross as JSON text in the forms of `contracts/interface/flowmark/dbspec.schema.json`. A
//! function that finds a diagnostic does not fail: its result is the object of its value or
//! `{"diagnostics": [..]}` (FMS-15). A text that is not of its form is `config`, with a message that names the member.

use std::path::Path;

use base64::Engine as _;
use polyspec_orm_schema::dbspec::json::{diagnostic_to_json, document_from_json, document_to_json, position_to_json, type_from_json};
use serde_json::{json, Value};

use crate::dbspec::{self, Diagnostic, Document, SetFile};
use crate::schema::Manifest;
use crate::{Error, Result};

/// The result of a function for an invalid text or set (FMS-15).
fn diagnostics(found: &[Diagnostic]) -> Value {
    json!({"diagnostics": found.iter().map(diagnostic_to_json).collect::<Vec<Value>>()})
}

/// The JSON value of the text `text`, which the argument `argument` holds.
fn value_of(text: &str, argument: &str) -> Result<Value> {
    serde_json::from_str(text).map_err(|error| Error::config(format!("{argument} is no JSON text: {error}")))
}

/// The documents of the JSON list `documents` (FMS-14, FMS-23).
fn documents_of(documents: &str) -> Result<Vec<Document>> {
    let Value::Array(items) = value_of(documents, "documents")? else { return Err(Error::config("documents is no list")) };
    items.iter().enumerate().map(|(index, item)| document_from_json(item).map_err(|refusal| Error::config(format!("documents[{index}]: {refusal}")))).collect()
}

/// The text of a path of a set; a path that is no Unicode text has no JSON text, so it is `config` (FMS-20, FMS-61).
fn path_text(path: &Path, set: &Path) -> Result<String> {
    match path.to_str() {
        Some(text) => Ok(text.to_owned()),
        None => Err(Error::config(format!("the set file {} names the path {}, which is no Unicode text", set.display(), path.display()))),
    }
}

/// Reads the set file at `path` and every file that it lists, as `dbspec::read_set` does (FMS-20):
/// `{"documents": [<file>, ..], "external": [<file>, ..]}` with each file as its joined path and its bytes in base64
/// with padding, or `{"errors": [<error>, ..]}`. The function reads files, so it takes the token of a member that waits
/// for blocking I/O (CORE-27), which the caller of the member gives.
pub fn read_set(_io: binding_core::Io, path: &Path) -> Result<String> {
    let files = |files: &[SetFile]| -> Result<Vec<Value>> {
        files
            .iter()
            .map(|file| Ok(json!({"path": path_text(&file.path, path)?, "bytes": base64::engine::general_purpose::STANDARD.encode(&file.bytes)})))
            .collect()
    };
    let result = match dbspec::read_set(path) {
        Ok(set) => json!({"documents": files(&set.documents)?, "external": files(&set.external)?}),
        Err(errors) => {
            let errors = errors
                .iter()
                .map(|error| Ok(json!({"rule": error.rule, "path": path_text(&error.path, path)?, "message": error.message})))
                .collect::<Result<Vec<Value>>>()?;
            json!({"errors": errors})
        }
    };
    Ok(result.to_string())
}

/// Checks the bytes of a document file, as `dbspec::read_bytes` does (FMS-21): `{"text": <text>}`, or the diagnostic
/// of the signature or of the encoding. `name` is the name that the message gives the file.
pub fn read_bytes(name: &str, bytes: &[u8]) -> String {
    match dbspec::read_bytes(name, bytes.to_vec()) {
        Ok(text) => json!({"text": text}).to_string(),
        Err(found) => diagnostics(&found).to_string(),
    }
}

fn texts(texts: &[String]) -> Vec<&str> {
    texts.iter().map(String::as_str).collect()
}

/// Parses the texts of one set, as `dbspec::parse_set` does (FMS-22): one object for each text, the owned texts first,
/// with `name` unless the header fails, `external`, `document` unless the text has a diagnostic, `positions` and
/// `diagnostics`. A parsed document that has no form is `internal`.
pub fn parse_set(owned: &[String], external: &[String]) -> Result<String> {
    let parsed = dbspec::parse_set(&texts(owned), &texts(external));
    let mut out = Vec::with_capacity(parsed.len());
    for text in &parsed {
        let mut item = serde_json::Map::new();
        if let Some(name) = &text.name {
            item.insert("name".into(), Value::from(name.as_str()));
        }
        item.insert("external".into(), Value::from(text.external));
        if let Some(document) = &text.document {
            let form = document_to_json(document).map_err(|refusal| Error::internal(format!("a parsed document has no JSON form: {refusal}")))?;
            item.insert("document".into(), form);
        }
        item.insert("positions".into(), Value::Array(text.positions.iter().map(position_to_json).collect()));
        item.insert("diagnostics".into(), Value::Array(text.diagnostics.iter().map(diagnostic_to_json).collect()));
        out.push(Value::Object(item));
    }
    Ok(Value::Array(out).to_string())
}

/// The manifest of the documents of one set, a JSON list, as `dbspec::manifest` does (FMS-23): `{"manifest": {..}}`
/// with the three texts and the two hashes, or the diagnostics of the set.
pub fn manifest(documents: &str) -> Result<String> {
    let documents = documents_of(documents)?;
    let set: Vec<&Document> = documents.iter().collect();
    Ok(match dbspec::manifest(&set) {
        Ok(manifest) => json!({"manifest": {
            "manifest_text": manifest.manifest_text,
            "external_text": manifest.external_text,
            "schema_text": manifest.schema_text,
            "manifest_hash": manifest.manifest_hash,
            "schema_hash": manifest.schema_hash,
        }}),
        Err(found) => diagnostics(&found),
    }
    .to_string())
}

/// The canonical text of the document of the JSON text `document`, as `dbspec::emit` writes it (FMS-24).
pub fn emit(document: &str) -> Result<String> {
    let document = document_from_json(&value_of(document, "document")?).map_err(Error::config)?;
    Ok(dbspec::emit(&document))
}

/// The statements that create the tables of the set in the dialect `dialect`, `mysql`, `postgres` or `sqlite`, in the
/// order of `dbspec::render_statements` (FMS-25): `{"statements": [{"sql": .., "table": ..}, ..]}`, or the diagnostics
/// of the set. Another dialect is `config`.
pub fn render_statements(documents: &str, dialect: &str) -> Result<String> {
    let dialect = match dialect {
        "mysql" => dbspec::Dialect::MySql,
        "postgres" => dbspec::Dialect::Postgres,
        "sqlite" => dbspec::Dialect::Sqlite,
        other => return Err(Error::config(format!("the dialect {other} is none of mysql, postgres and sqlite"))),
    };
    let documents = documents_of(documents)?;
    let set: Vec<&Document> = documents.iter().collect();
    Ok(match dbspec::render_statements(&set, dialect) {
        Ok(statements) => {
            json!({"statements": statements.iter().map(|statement| json!({"sql": statement.sql, "table": statement.table})).collect::<Vec<Value>>()})
        }
        Err(found) => diagnostics(&found),
    }
    .to_string())
}

/// The canonical text of `literal` as the default of a column of the type of the JSON text `ty`, or `None` when
/// `literal` is no literal of the type (FMS-26).
pub fn canonical_literal(ty: &str, literal: &str) -> Result<Option<String>> {
    let ty = type_from_json(&value_of(ty, "type")?).map_err(Error::config)?;
    Ok(dbspec::canonical_literal(ty, literal))
}

/// The runtime model of the documents of one set, a JSON list (FMS-27): `{"model": <model>}` with the entities of
/// `dbspec::runtime_model` and the manifest hash of `dbspec::manifest` of the same documents, or the diagnostics of the
/// set.
pub fn runtime_model(documents: &str) -> Result<String> {
    let documents = documents_of(documents)?;
    let set: Vec<&Document> = documents.iter().collect();
    let result = match (dbspec::manifest(&set), dbspec::runtime_model(&set)) {
        (Ok(manifest), Ok(model)) => {
            let model = Manifest { manifest_hash: manifest.manifest_hash, model }.to_json();
            json!({"model": model})
        }
        (Err(found), _) | (_, Err(found)) => diagnostics(&found),
    };
    Ok(result.to_string())
}

#[cfg(test)]
#[path = "../tests/unit/flowmark_surface.rs"]
mod flowmark_surface_tests;
