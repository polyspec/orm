//! The parts of schema.json the generator reads.

use std::collections::{BTreeMap, HashMap};

use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize, Debug)]
pub struct Manifest {
    pub schema_hash: String,
    #[serde(default)]
    pub order: Vec<String>,
    pub entities: HashMap<String, Entity>,
}

#[derive(Deserialize, Debug)]
pub struct Entity {
    pub name: String,
    pub columns: Vec<Column>,
    #[serde(default)]
    pub indexes: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub fulltext: Vec<Vec<String>>,
}

#[derive(Deserialize, Debug)]
pub struct Column {
    pub name: String,
    #[serde(rename = "type")]
    pub typ: String,
    #[serde(default)]
    pub nullable: bool,
    #[serde(default)]
    pub styles: Vec<String>,
}

impl Manifest {
    pub fn load(text: &str) -> Result<Manifest, String> {
        let m: Manifest = serde_json::from_str(text).map_err(|e| format!("schema manifest: {e}"))?;
        let hash = content_hash(text).ok_or("schema manifest must start with schema_hash")?;
        if hash != m.schema_hash {
            return Err(format!("schema.json was edited by hand: hash {} does not match content {hash}", m.schema_hash));
        }
        for name in &m.order {
            if !m.entities.contains_key(name) {
                return Err(format!("schema manifest: order names unknown entity {name}"));
            }
        }
        Ok(m)
    }

    pub fn entities(&self) -> impl Iterator<Item = &Entity> {
        self.order.iter().map(|n| &self.entities[n])
    }
}

impl Entity {
    pub fn column(&self, name: &str) -> Option<&Column> {
        self.columns.iter().find(|c| c.name == name)
    }
}

impl Column {
    /// The style stages the executor applies (aes, hex, and ip are not among them).
    pub fn app_styles(&self) -> impl Iterator<Item = &str> {
        self.styles.iter().map(String::as_str).filter(|s| !matches!(*s, "aes" | "hex" | "ip"))
    }

    pub fn styled(&self) -> bool {
        self.app_styles().next().is_some()
    }

    pub fn numeric(&self) -> bool {
        !self.styled() && matches!(self.typ.as_str(), "i32" | "i64" | "f64" | "decimal")
    }

    /// Columns that accept column functions.
    pub fn function_column(&self) -> bool {
        !self.styled() && matches!(self.typ.as_str(), "date" | "datetime" | "point")
    }
}

/// SHA-256 of the compact manifest with an empty schema_hash, first 8 bytes.
fn content_hash(text: &str) -> Option<String> {
    let mut compact = String::with_capacity(text.len());
    let (mut in_string, mut escaped) = (false, false);
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
            in_string = ch == '"';
            compact.push(ch);
        }
    }
    let head = "{\"schema_hash\":\"";
    let rest = compact.strip_prefix(head)?;
    let end = rest.find('"')?;
    let sum = Sha256::digest(format!("{head}{}", &rest[end..]).as_bytes());
    Some(sum[..8].iter().map(|b| format!("{b:02x}")).collect())
}

const RESERVED_SEGMENTS: &[&str] = &["and", "or", "with", "gt", "lt", "ge", "le", "eq", "ne", "lk", "lb", "between", "fulltext", "tuple"];
const RESERVED_PREFIXES: &[&str] = &[
    "and", "or", "get", "set", "new", "plus", "minus", "order_by", "group_by", "tuple", "gt", "lt", "ge", "le", "eq", "ne", "lk", "lb", "between", "fulltext",
];
const RESERVED_COLUMNS: &[&str] = &[
    "and",
    "or",
    "get",
    "gets",
    "gets_page",
    "get_query",
    "limit",
    "alias",
    "connect",
    "create",
    "creates",
    "update",
    "delete",
    "save",
    "raw",
    "on",
    "random",
];

/// The column naming rules of the model syntax.
pub fn check_column_name(n: &str) -> Result<(), String> {
    let snake = n.starts_with(|c: char| c.is_ascii_lowercase()) && n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if !snake {
        return Err(format!("column name must be snake_case: {n}"));
    }
    if n.contains("__") {
        return Err(format!("column name may not contain '__': {n}"));
    }
    if let Some(s) = n.split('_').find(|s| RESERVED_SEGMENTS.contains(s)) {
        return Err(format!("column name may not contain the segment {s:?}: {n}"));
    }
    if RESERVED_COLUMNS.contains(&n) {
        return Err(format!("column name is a reserved method name: {n}"));
    }
    if let Some(p) = RESERVED_PREFIXES.iter().find(|p| n == **p || n.starts_with(&format!("{p}_"))) {
        return Err(format!("column name may not start with {p:?}: {n}"));
    }
    Ok(())
}
