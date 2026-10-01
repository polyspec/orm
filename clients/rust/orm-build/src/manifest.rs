//! generator가 읽는 dbspec document set: manifest text, `manifestHash`, runtime model
//! (docs/dbspec.md, "Manifest and hashes", "Runtime model").

use std::collections::BTreeMap;
use std::path::Path;

use orm_schema::dbspec::{self, Document, Field, RuntimeModel};

/// 한 document set의 manifest와 runtime model.
pub struct DocumentSet {
    pub manifest_text: String,
    pub manifest_hash: String,
    pub model: RuntimeModel,
}

fn diagnostics(path: &str, errors: Vec<dbspec::Diagnostic>) -> String {
    errors.iter().map(|e| format!("{path}: {e}")).collect::<Vec<_>>().join("\n")
}

/// `paths`의 dbspec document를 읽는다. 각 document는 나머지 document를 declared
/// document set으로 삼아 parse한다.
pub fn load(paths: &[&Path]) -> Result<DocumentSet, String> {
    if paths.is_empty() {
        return Err("the document set has no dbspec document".into());
    }
    let mut texts = Vec::with_capacity(paths.len());
    for path in paths {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let name = text.lines().next().and_then(|header| header.split(' ').nth(2)).unwrap_or("").to_owned();
        texts.push((path.display().to_string(), name, text));
    }
    let set: BTreeMap<String, String> = texts.iter().map(|(_, name, text)| (name.clone(), text.clone())).collect();
    let mut documents: Vec<Document> = Vec::with_capacity(texts.len());
    for (path, _, text) in &texts {
        documents.push(dbspec::parse(text, &set).map_err(|errors| diagnostics(path, errors))?);
    }
    let refs: Vec<&Document> = documents.iter().collect();
    let manifest = dbspec::manifest(&refs).map_err(|errors| diagnostics("document set", errors))?;
    let model = dbspec::runtime_model(&refs).map_err(|errors| diagnostics("document set", errors))?;
    Ok(DocumentSet { manifest_text: manifest.manifest_text, manifest_hash: manifest.manifest_hash, model })
}

/// executor codec이 적용하는 stage (`aes`, `hex`, `ip`는 빠진다).
pub fn executor_stages(c: &Field) -> impl Iterator<Item = &str> {
    c.codec.iter().map(String::as_str).filter(|s| !matches!(*s, "aes" | "hex" | "ip"))
}

/// executor codec stage가 있는 column.
pub fn styled(c: &Field) -> bool {
    executor_stages(c).next().is_some()
}

pub fn numeric(c: &Field) -> bool {
    !styled(c) && matches!(c.ty.name(), "i16" | "i32" | "i64" | "f64" | "decimal")
}

/// column function을 받는 column.
pub fn function_column(c: &Field) -> bool {
    !styled(c) && matches!(c.ty.name(), "date" | "datetime")
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
