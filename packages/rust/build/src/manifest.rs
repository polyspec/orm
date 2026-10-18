//! The dbspec document set read by the generator: manifest text, `manifestHash`, runtime model
//! (docs/dbspec.md, "Manifest and hashes", "Runtime model").

use polyspec_orm_schema::dbspec::{self, Document, Field, RuntimeModel};

/// The manifest and runtime model of one document set.
pub struct DocumentSet {
    pub manifest_text: String,
    /// The text of the tables the set uses from external documents. Empty if there are no external documents.
    pub external_text: String,
    pub manifest_hash: String,
    pub model: RuntimeModel,
}

fn diagnostics(path: &str, errors: Vec<dbspec::Diagnostic>) -> String {
    errors.iter().map(|e| format!("{path}: {e}")).collect::<Vec<_>>().join("\n")
}

/// Loads the document set that `dbspec::read_set` read: each file's bytes go to `dbspec::read_bytes`
/// with its joined path, and each document whose bytes pass is parsed with every other such
/// document as its declared document set; every diagnostic of every file is reported together.
/// The external documents are marked `external`; their used tables become external models.
pub fn load_set(files: &dbspec::Set) -> Result<DocumentSet, String> {
    let mut paths = (Vec::new(), Vec::new());
    let mut texts = (Vec::new(), Vec::new());
    let mut failures = Vec::new();
    let owned = files.documents.len();
    for (i, file) in files.documents.iter().chain(&files.external).enumerate() {
        let path = file.path.display().to_string();
        // A file without the signature fails with the diagnostic of dbspec::read_bytes before parsing.
        match dbspec::read_bytes(&path, file.bytes.clone()) {
            Ok(text) if i < owned => {
                paths.0.push(path);
                texts.0.push(text);
            }
            Ok(text) => {
                paths.1.push(path);
                texts.1.push(text);
            }
            Err(errors) => failures.push(diagnostics(&path, errors)),
        }
    }
    // The documents whose bytes passed are parsed as one set, so that one generation reports the
    // diagnostics of every document.
    let owned_texts: Vec<&str> = texts.0.iter().map(String::as_str).collect();
    let external_texts: Vec<&str> = texts.1.iter().map(String::as_str).collect();
    let set = dbspec::parse_set(&owned_texts, &external_texts);
    let mut documents: Vec<Document> = Vec::with_capacity(set.len());
    for (path, result) in paths.0.iter().chain(&paths.1).zip(set) {
        match result.document {
            Some(document) => documents.push(document),
            None => failures.push(diagnostics(path, result.diagnostics)),
        }
    }
    if !failures.is_empty() {
        return Err(failures.join("\n"));
    }
    let refs: Vec<&Document> = documents.iter().collect();
    let manifest = dbspec::manifest(&refs).map_err(|errors| diagnostics("document set", errors))?;
    let model = dbspec::runtime_model(&refs).map_err(|errors| diagnostics("document set", errors))?;
    Ok(DocumentSet { manifest_text: manifest.manifest_text, external_text: manifest.external_text, manifest_hash: manifest.manifest_hash, model })
}

/// Stages the executor codec applies (`aes`, `hex`; `ip` is left out).
pub fn executor_stages(c: &Field) -> impl Iterator<Item = &str> {
    c.codec.iter().map(String::as_str).filter(|s| !matches!(*s, "aes" | "hex" | "ip"))
}

/// Columns that have an executor codec stage.
pub fn styled(c: &Field) -> bool {
    executor_stages(c).next().is_some()
}

pub fn numeric(c: &Field) -> bool {
    !styled(c) && matches!(c.ty.name(), "i16" | "i32" | "i64" | "f64" | "decimal")
}

/// Columns that take a column function.
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
    "not",
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
    "restore",
    "save",
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

#[cfg(test)]
mod tests {
    use super::check_column_name;

    // A column with the same name as a fixed model method would collide with the generated method, so it is rejected.
    #[test]
    fn reserved_method_names_are_not_columns() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        for name in ["create", "delete", "restore", "random"] {
            let error = check_column_name(name).expect_err(name);
            assert!(error.contains("reserved method name"), "{name}: {error}");
        }
        assert_eq!(check_column_name("restored_at"), Ok(()));
    }
}
