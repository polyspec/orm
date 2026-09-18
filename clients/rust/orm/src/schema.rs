//! The schema manifest (schema.json) and the embedded schema of generated
//! models.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, OnceLock};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{codes, Error, Result};

#[derive(Deserialize, Debug, Clone)]
pub struct Manifest {
    pub schema_hash: String,
    #[serde(default)]
    pub order: Vec<String>,
    pub entities: HashMap<String, EntitySchema>,
    #[serde(default)]
    pub external_fks: Vec<ExternalFk>,
    #[serde(default)]
    pub immutable: Vec<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ExternalFk {
    pub entity: String,
    pub columns: Vec<String>,
    pub target_table: String,
    pub target_columns: Vec<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub on_delete: String,
    #[serde(default)]
    pub deferred: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct EntitySchema {
    pub name: String,
    pub table: String,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub pk: Vec<String>,
    #[serde(default)]
    pub auto: String,
    pub columns: Vec<ColumnSchema>,
    #[serde(default)]
    pub relations: BTreeMap<String, Relation>,
    #[serde(default)]
    pub unique: Vec<Vec<String>>,
    #[serde(default)]
    pub indexes: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub fulltext: Vec<Vec<String>>,
    #[serde(default)]
    pub checks: Vec<Check>,
    #[serde(default)]
    pub timestamps: Option<Timestamps>,
    #[serde(default)]
    pub soft_delete: String,
    #[serde(default)]
    pub aes_version: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Check {
    pub name: String,
    pub expr: String,
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct Timestamps {
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub updated: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ColumnSchema {
    pub name: String,
    #[serde(rename = "type")]
    pub typ: String,
    #[serde(default)]
    pub raw: String,
    #[serde(default)]
    pub nullable: bool,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub auto: bool,
    #[serde(default)]
    pub on_update: bool,
    #[serde(default)]
    pub unsigned: bool,
    #[serde(default)]
    pub lazy: bool,
    #[serde(default)]
    pub len: i64,
    #[serde(default)]
    pub precision: i64,
    #[serde(default)]
    pub scale: i64,
    #[serde(default)]
    pub styles: Vec<String>,
    #[serde(default)]
    pub blind_index: String,
    #[serde(default, rename = "ref")]
    pub reference: Option<ColumnRef>,
    #[serde(default)]
    pub pk: bool,
    #[serde(default)]
    pub fk: bool,
    #[serde(default)]
    pub comment: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ColumnRef {
    pub entity: String,
    pub column: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Relation {
    pub name: String,
    pub kind: String,
    pub target: String,
    #[serde(default)]
    pub keys: Vec<RelationKey>,
    #[serde(default)]
    pub on_delete: String,
    #[serde(default)]
    pub foreign_key: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct RelationKey {
    pub local: String,
    pub target: String,
}

impl Manifest {
    /// Reads a schema.json and checks that its content matches its hash.
    pub fn load(schema_json: &[u8]) -> Result<Manifest> {
        let invalid = |msg: String| Error::Engine { code: codes::SCHEMA_INVALID.into(), msg };
        let manifest: Manifest = serde_json::from_slice(schema_json).map_err(|e| invalid(format!("schema manifest: {e}")))?;
        let text = std::str::from_utf8(schema_json).map_err(|e| invalid(format!("schema manifest: {e}")))?;
        let hash = content_hash(text).ok_or_else(|| invalid("schema manifest must start with schema_hash".into()))?;
        if hash != manifest.schema_hash {
            return Err(invalid(format!("schema.json was edited by hand: hash {} does not match content {hash}", manifest.schema_hash)));
        }
        Ok(manifest)
    }

    pub fn entity(&self, name: &str) -> Result<&EntitySchema> {
        self.entities
            .get(name)
            .ok_or_else(|| Error::Engine { code: codes::ENTITY_UNKNOWN.into(), msg: name.to_owned() })
    }
}

/// The hash of a generated manifest: SHA-256 of the compact JSON with an empty
/// schema_hash, first 8 bytes in hex. The generator writes keys in a fixed
/// order, so compacting the text reproduces the hashed bytes.
fn content_hash(text: &str) -> Option<String> {
    let mut compact = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;
    for ch in text.chars() {
        if in_string {
            compact.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
        } else if !ch.is_ascii_whitespace() {
            if ch == '"' {
                in_string = true;
            }
            compact.push(ch);
        }
    }
    let head = "{\"schema_hash\":\"";
    let rest = compact.strip_prefix(head)?;
    let end = rest.find('"')?;
    let canonical = format!("{head}{}", &rest[end..]);
    let sum = Sha256::digest(canonical.as_bytes());
    Some(sum[..8].iter().map(|b| format!("{b:02x}")).collect())
}

impl EntitySchema {
    pub fn column(&self, name: &str) -> Option<&ColumnSchema> {
        self.columns.iter().find(|c| c.name == name)
    }

    /// The column that records the last update of a row.
    pub fn updated_column(&self) -> &str {
        self.timestamps.as_ref().map(|t| t.updated.as_str()).unwrap_or("")
    }
}

impl ColumnSchema {
    /// The codec stages the executor applies (aes/hex/ip stay host stages).
    pub fn codec_styles(&self) -> Vec<&str> {
        self.styles.iter().map(String::as_str).filter(|s| !matches!(*s, "aes" | "hex" | "ip")).collect()
    }

    pub fn is_aes(&self) -> bool {
        self.styles.iter().any(|s| s == "aes")
    }
}

/// The schema embedded in generated models. It is parsed once, on first use.
pub struct Schema {
    json: &'static [u8],
    hash: &'static str,
    manifest: OnceLock<std::result::Result<Arc<Manifest>, String>>,
}

impl Schema {
    pub const fn new(json: &'static [u8], hash: &'static str) -> Schema {
        Schema { json, hash, manifest: OnceLock::new() }
    }

    /// The hash the models were generated from.
    pub fn hash(&self) -> &'static str {
        self.hash
    }

    /// The schema.json text.
    pub fn json(&self) -> &'static [u8] {
        self.json
    }

    /// The parsed manifest.
    pub fn manifest(&self) -> Result<Arc<Manifest>> {
        self.manifest
            .get_or_init(|| match Manifest::load(self.json) {
                Ok(m) if m.schema_hash == self.hash => Ok(Arc::new(m)),
                Ok(m) => Err(format!("models were generated from schema {} but the embedded schema is {}", self.hash, m.schema_hash)),
                Err(e) => Err(e.to_string()),
            })
            .clone()
            .map_err(|msg| Error::Engine { code: codes::SCHEMA_INVALID.into(), msg })
    }
}
