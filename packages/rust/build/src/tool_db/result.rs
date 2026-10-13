use super::Rows;

#[derive(Debug, Clone, PartialEq)]
pub struct QueryColumn {
    pub name: String,
    pub native_type: String,
}
#[derive(Debug, Clone, PartialEq)]
pub struct QueryResult {
    pub columns: Vec<QueryColumn>,
    pub rows: Rows,
}
pub(super) fn columns<'a>(values: impl IntoIterator<Item = (&'a str, &'a str)>) -> Result<Vec<QueryColumn>, sqlx::Error> {
    let mut result = Vec::new();
    let mut bytes = 0usize;
    for (name, native_type) in values {
        bytes = bytes.checked_add(name.len()).and_then(|n| n.checked_add(native_type.len())).filter(|n| *n <= 64 * 1024).ok_or_else(error)?;
        if result.len() >= 2048 {
            return Err(error());
        }
        result.push(QueryColumn { name: name.to_owned(), native_type: native_type.to_owned() });
    }
    Ok(result)
}
fn error() -> sqlx::Error {
    sqlx::Error::Decode("TOOL_QUERY_COLUMNS: column metadata budget exceeded".into())
}

#[cfg(test)]
#[path = "../../tests/unit/tool_column_budgets.rs"]
mod tests;
