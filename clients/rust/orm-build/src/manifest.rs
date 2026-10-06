//! generator가 읽는 dbspec document set: manifest text, `manifestHash`, runtime model
//! (docs/dbspec.md, "Manifest and hashes", "Runtime model").

use std::collections::BTreeMap;
use std::path::Path;

use polyspec_orm_schema::dbspec::{self, Document, Field, RuntimeModel};

/// 한 document set의 manifest와 runtime model.
pub struct DocumentSet {
    pub manifest_text: String,
    /// 외부 문서에서 set이 쓰는 table의 text. 외부 문서가 없으면 비어 있다.
    pub external_text: String,
    pub manifest_hash: String,
    pub model: RuntimeModel,
}

fn diagnostics(path: &str, errors: Vec<dbspec::Diagnostic>) -> String {
    errors.iter().map(|e| format!("{path}: {e}")).collect::<Vec<_>>().join("\n")
}

/// `dbspec::read_file`로 소유한 document `paths`와 외부 document `uses`(set이 use로 쓰지만 소유하지 않는 다른 set의 문서)를 읽는다.
/// 각 document는 나머지 모든 document를 declared document set으로 삼아 parse하고, 외부 document는 `external`로
/// 표시한다. 외부 document의 table은 model이 되지 않는다.
pub fn load_set(paths: &[&Path], uses: &[&Path]) -> Result<DocumentSet, String> {
    if paths.is_empty() {
        return Err("the document set has no dbspec document".into());
    }
    let mut texts = Vec::with_capacity(paths.len() + uses.len());
    for path in paths.iter().chain(uses) {
        // signature가 없는 파일은 parse 전에 dbspec::read_file의 diagnostic으로 실패한다.
        let text = dbspec::read_file(path).map_err(|e| match e {
            dbspec::ReadError::Io(error) => format!("{}: {error}", path.display()),
            dbspec::ReadError::Diagnostics(errors) => diagnostics(&path.display().to_string(), errors),
        })?;
        let name = text.lines().next().and_then(|header| header.split(' ').nth(2)).unwrap_or("").to_owned();
        texts.push((path.display().to_string(), name, text));
    }
    let set: BTreeMap<String, String> = texts.iter().map(|(_, name, text)| (name.clone(), text.clone())).collect();
    let mut documents: Vec<Document> = Vec::with_capacity(texts.len());
    for (i, (path, name, text)) in texts.iter().enumerate() {
        let others: BTreeMap<String, String> = set.iter().filter(|(other, _)| *other != name).map(|(k, v)| (k.clone(), v.clone())).collect();
        let mut document = dbspec::parse(text, &others).map_err(|errors| diagnostics(path, errors))?;
        document.external = i >= paths.len();
        documents.push(document);
    }
    let refs: Vec<&Document> = documents.iter().collect();
    let manifest = dbspec::manifest(&refs).map_err(|errors| diagnostics("document set", errors))?;
    let model = dbspec::runtime_model(&refs).map_err(|errors| diagnostics("document set", errors))?;
    Ok(DocumentSet { manifest_text: manifest.manifest_text, external_text: manifest.external_text, manifest_hash: manifest.manifest_hash, model })
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

    // 고정 model method와 같은 이름의 column은 생성한 method와 겹치므로 거부한다.
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
