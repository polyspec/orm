//! Explicit table pages retain native column/key provenance, not edit authority.
use super::{metadata, read_only, temporal, TableMetadata, TableRef};
use crate::tool_db::{Conn, GridQueryResult, QueryLimits};

#[derive(Debug)]
pub struct TablePage {
    pub metadata: TableMetadata,
    pub result: GridQueryResult,
    pub limit: usize,
    pub offset: u64,
    pub order_by: Vec<String>,
    pub has_more: bool,
}
pub(super) fn validate_request(table: &TableRef, limit: usize, offset: u64) -> Result<(), String> {
    metadata::validate_name(&table.namespace)?;
    metadata::validate_name(&table.name)?;
    if !(1..=1000).contains(&limit) || offset > 1_000_000 {
        return Err("TABLE_PAGE_INVALID: limit requires 1..1000 and offset 0..1000000".into());
    }
    Ok(())
}
pub(super) fn quote(value: &str, dialect: &str) -> Result<String, String> {
    let mark = match dialect {
        "mysql" => '`',
        "postgres" | "sqlite" => '"',
        _ => return Err("TABLE_DIALECT_UNSUPPORTED".into()),
    };
    Ok(format!("{mark}{}{mark}", value.replace(mark, &format!("{mark}{mark}"))))
}
pub(super) async fn read(connection: &mut Conn, dialect: &str, table: &TableRef, limit: usize, offset: u64) -> Result<TablePage, String> {
    let metadata = metadata::describe(connection, dialect, table).await?;
    if metadata.columns.is_empty() {
        return Err("TABLE_PAGE_UNSUPPORTED: relation has no selectable columns".into());
    }
    let columns = metadata.columns.iter().map(|column| quote(&column.name, dialect)).collect::<Result<Vec<_>, _>>()?;
    let order_by = metadata.primary_key.clone();
    let order = if order_by.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", order_by.iter().map(|column| quote(column, dialect)).collect::<Result<Vec<_>, _>>()?.join(","))
    };
    let sql = format!(
        "SELECT {} FROM {}.{}{order} LIMIT {} OFFSET {offset}",
        columns.join(","),
        quote(&table.namespace, dialect)?,
        quote(&table.name, dialect)?,
        limit + 1
    );
    read_only::validate(&sql, dialect)?;
    let result = temporal::read(connection, &metadata, dialect, &sql, &[], QueryLimits { max_rows: limit + 1, max_bytes: 8 * 1024 * 1024 }).await?;
    let after = metadata::describe(connection, dialect, table).await?;
    assemble(metadata, result, after, limit, offset)
}
fn assemble(metadata: TableMetadata, mut result: GridQueryResult, after: TableMetadata, limit: usize, offset: u64) -> Result<TablePage, String> {
    if result.columns.len() != metadata.columns.len() || result.columns.iter().zip(&metadata.columns).any(|(actual, declared)| actual.name != declared.name) {
        return Err("TABLE_PAGE_METADATA_CHANGED: prepared columns differ from descriptor".into());
    }
    if after != metadata {
        return Err("TABLE_PAGE_METADATA_CHANGED: descriptor changed during read".into());
    }
    let has_more = result.rows.len() > limit;
    if has_more {
        result.rows.pop();
    }
    let order_by = metadata.primary_key.clone();
    Ok(TablePage { metadata, result, limit, offset, order_by, has_more })
}

#[cfg(test)]
#[path = "../../tests/unit/table_page_validation.rs"]
mod tests;
