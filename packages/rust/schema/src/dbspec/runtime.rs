//! The runtime model of a document set, shared by the ORM runtime and the model generator
//! (docs/dbspec.md, "Runtime model") and documents read again from manifest text.

use super::model::{DefaultValue, Document, Setting, Table, Type};
use super::Diagnostic;
use std::collections::BTreeMap;

/// Entities of the document set: documents are in name order, and tables are in document order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeModel {
    pub entities: Vec<Entity>,
}

/// One table as seen by the ORM.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entity {
    /// The `entity` setting, or the table name if there is none.
    pub name: String,
    pub table: String,
    /// One field per column, in column order.
    pub fields: Vec<Field>,
    pub primary_key: Vec<String>,
    /// identity column.
    pub identity: Option<String>,
    pub uniques: Vec<Key>,
    pub indexes: Vec<Key>,
    pub foreign_keys: Vec<ForeignKey>,
    /// `updated` column.
    pub updated: Option<String>,
    /// `soft_delete` column.
    pub soft_delete: Option<String>,
    /// `aes_version` column.
    pub aes_version: Option<String>,
    pub audit: Option<Audit>,
    pub immutable: bool,
    /// A used table of an external document: it is read like any entity, and every write fails with `CONFIG` before
    /// any statement (docs/dbspec.md "External documents").
    pub external: bool,
}

/// One column as seen by the ORM.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Field {
    pub name: String,
    pub ty: Type,
    pub nullable: bool,
    pub identity: bool,
    pub primary_key: bool,
    /// A column that belongs to a foreign key.
    pub foreign_key: bool,
    pub default: Option<FieldDefault>,
    /// A column named by `select explicit`, so it is left out of the default select set.
    pub select_explicit: bool,
    /// The codec stage in write order.
    pub codec: Vec<String>,
    /// The index column determined by the `blind_index` setting of this AES column.
    pub blind_index: Option<String>,
}

/// The column's default.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FieldDefault {
    /// `default now`.
    Now,
    /// The literal of the canonical text.
    Literal(String),
}

/// A named unique key or index, and its columns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Key {
    pub name: String,
    pub columns: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub table: String,
    pub references: Vec<String>,
}

/// `audit` setting (docs/dbspec.md, "Audit").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Audit {
    pub history: String,
    /// The column holding the audit record key of the transaction.
    pub column: String,
    /// The name of the audit record table.
    pub record: String,
    pub action: String,
    pub previous: String,
}

impl RuntimeModel {
    /// The entity named `name`.
    pub fn entity(&self, name: &str) -> Option<&Entity> {
        self.entities.iter().find(|e| e.name == name)
    }
}

impl Entity {
    /// The field named `name`.
    pub fn field(&self, name: &str) -> Option<&Field> {
        self.fields.iter().find(|f| f.name == name)
    }
}

impl Field {
    /// The field holds a styled value of the common value model: one of its codec stages
    /// is `ordered_json`, `serialize`, `yaml`, `gz`, or `base64` (docs/dbspec.md, "Runtime model").
    pub fn styled_value(&self) -> bool {
        self.codec.iter().any(|s| matches!(s.as_str(), "ordered_json" | "serialize" | "yaml" | "gz" | "base64"))
    }

    /// The field is encrypted by the `aes` stage.
    pub fn aes(&self) -> bool {
        self.codec.iter().any(|s| s == "aes")
    }
}

/// Returns the runtime model of the document set with documents in name order. An entity is a table of an owned document or
/// a used table of an external document, an external entity reduced to its columns, primary key and unique keys as the
/// external text holds it. For an invalid document set, returns the same diagnostic as `manifest`.
pub fn runtime_model(documents: &[&Document]) -> Result<RuntimeModel, Vec<Diagnostic>> {
    let ordered = super::check_set(documents)?;
    let used: Vec<(&str, &str)> = ordered
        .iter()
        .filter(|d| !d.external)
        .flat_map(|d| d.uses.iter())
        .flat_map(|u| u.tables.iter().map(move |t| (u.document.text.as_str(), t.text.as_str())))
        .collect();
    let mut entities = Vec::new();
    for d in &ordered {
        for t in &d.tables {
            if !d.external {
                entities.push(entity(t));
            } else if used.contains(&(d.name.text.as_str(), t.name.text.as_str())) {
                let reduced = Table { indexes: Vec::new(), foreign_keys: Vec::new(), checks: Vec::new(), settings: None, ..t.clone() };
                entities.push(Entity { external: true, ..entity(&reduced) });
            }
        }
    }
    Ok(RuntimeModel { entities })
}

fn entity(table: &Table) -> Entity {
    let lines: Vec<&Setting> = table.settings.iter().flat_map(|s| s.lines.iter()).map(|l| &l.setting).collect();
    let column = |find: fn(&Setting) -> Option<&super::model::Name>| lines.iter().find_map(|s| find(s)).map(|n| n.text.clone());
    let name = column(|s| if let Setting::Entity(n) = s { Some(n) } else { None }).unwrap_or_else(|| table.name.text.clone());
    let primary_key: Vec<String> = table.primary.iter().flat_map(|k| k.columns.iter()).map(|n| n.text.clone()).collect();
    let fields = table
        .columns
        .iter()
        .map(|c| {
            let name = c.name.text.clone();
            let codec = lines
                .iter()
                .find_map(|s| match s {
                    Setting::Codec(col, stages) if col.text == name => Some(stages.iter().map(|n| n.text.clone()).collect()),
                    _ => None,
                })
                .unwrap_or_default();
            let blind_index = lines.iter().find_map(|s| match s {
                Setting::BlindIndex(col, index) if col.text == name => Some(index.text.clone()),
                _ => None,
            });
            Field {
                ty: c.ty,
                nullable: c.nullable,
                identity: c.identity.is_some(),
                primary_key: primary_key.contains(&name),
                foreign_key: table.foreign_keys.iter().any(|k| k.columns.iter().any(|n| n.text == name)),
                default: c.default.as_ref().map(|d| match d {
                    DefaultValue::Now => FieldDefault::Now,
                    DefaultValue::Literal(text) => FieldDefault::Literal(text.clone()),
                }),
                select_explicit: lines.iter().any(|s| matches!(s, Setting::SelectExplicit(names) if names.iter().any(|n| n.text == name))),
                codec,
                blind_index,
                name,
            }
        })
        .collect();
    let keys = |names: &[super::model::Name]| names.iter().map(|n| n.text.clone()).collect::<Vec<_>>();
    Entity {
        name,
        table: table.name.text.clone(),
        fields,
        identity: table.columns.iter().find(|c| c.identity.is_some()).map(|c| c.name.text.clone()),
        primary_key,
        uniques: table.uniques.iter().map(|u| Key { name: u.name.text.clone(), columns: keys(&u.columns) }).collect(),
        indexes: table.indexes.iter().map(|i| Key { name: i.name.text.clone(), columns: i.columns.iter().map(|(n, _)| n.text.clone()).collect() }).collect(),
        foreign_keys: table
            .foreign_keys
            .iter()
            .map(|k| ForeignKey { name: k.name.text.clone(), columns: keys(&k.columns), table: k.table.text.clone(), references: keys(&k.references) })
            .collect(),
        updated: column(|s| if let Setting::Updated(n) = s { Some(n) } else { None }),
        soft_delete: column(|s| if let Setting::SoftDelete(n) = s { Some(n) } else { None }),
        aes_version: column(|s| if let Setting::AesVersion(n) = s { Some(n) } else { None }),
        audit: lines.iter().find_map(|s| match s {
            Setting::Audit { into, column, references, action, previous, .. } => Some(Audit {
                history: into.text.clone(),
                column: column.text.clone(),
                record: references.text.clone(),
                action: action.text.clone(),
                previous: previous.text.clone(),
            }),
            _ => None,
        }),
        immutable: lines.iter().any(|s| matches!(s, Setting::Immutable)),
        external: false,
    }
}

/// Reads the documents of the manifest text (docs/dbspec.md, "Manifest and hashes").
/// A document starts at its header line, and each document treats the remaining documents as declared
/// document set when parsed. A diagnostic has the manifest text's line
/// and names the document in its message. Text before the first header is a `header` error.
pub fn parse_manifest(text: &str) -> Result<Vec<Document>, Vec<Diagnostic>> {
    parse_manifest_set(text, "")
}

/// Parses the documents of the manifest text and of the external text (the tables the set uses from external documents, `Manifest::external_text`)
/// . Each document is parsed with all other documents of both texts as its set, and documents of the external text are
/// marked `external`.
pub fn parse_manifest_set(text: &str, external: &str) -> Result<Vec<Document>, Vec<Diagnostic>> {
    let owned = manifest_chunks(text)?;
    let externals = if external.is_empty() { Vec::new() } else { manifest_chunks(external)? };
    let set: BTreeMap<String, String> = owned.iter().chain(&externals).map(|(_, name, chunk)| (name.clone(), chunk.clone())).collect();
    let mut documents = Vec::with_capacity(owned.len() + externals.len());
    let mut errors = Vec::new();
    for (chunks, is_external) in [(&externals, true), (&owned, false)] {
        for (start, name, chunk) in chunks {
            let others: BTreeMap<String, String> = set.iter().filter(|(other, _)| *other != name).map(|(k, v)| (k.clone(), v.clone())).collect();
            match super::parse(chunk, &others) {
                Ok(parsed) => {
                    let mut document = parsed.document;
                    document.external = is_external;
                    documents.push(document);
                }
                Err(diagnostics) => {
                    errors.extend(diagnostics.into_iter().map(|d| Diagnostic { line: d.line + start, message: format!("document {name}: {}", d.message), ..d }))
                }
            }
        }
    }
    if errors.is_empty() {
        Ok(documents)
    } else {
        Err(errors)
    }
}

/// Splits the manifest text per document into (start line, name, text).
fn manifest_chunks(text: &str) -> Result<Vec<(usize, String, String)>, Vec<Diagnostic>> {
    let mut chunks: Vec<(usize, String, String)> = Vec::new();
    for (i, line) in text.split_inclusive('\n').enumerate() {
        if line.starts_with("dbspec ") {
            let name = super::parser::header_name(line.trim_end_matches(['\r', '\n'])).unwrap_or_default();
            chunks.push((i, name, String::new()));
        }
        match chunks.last_mut() {
            Some((_, _, chunk)) => chunk.push_str(line),
            None => {
                return Err(vec![Diagnostic {
                    rule: "header".into(),
                    line: i + 1,
                    column: 1,
                    message: "a manifest text starts with a document header".into(),
                }]);
            }
        }
    }
    if chunks.is_empty() {
        return Err(vec![Diagnostic { rule: "header".into(), line: 1, column: 1, message: "a manifest text holds at least one document".into() }]);
    }
    Ok(chunks)
}
