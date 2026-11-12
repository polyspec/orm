//! Explicit table pages retain native column/key provenance, not edit authority.
use super::CatalogError;
use super::{metadata, read_only, temporal, TableMetadata, TableRef};
use crate::tool_db::{Conn, GridQueryResult, QueryLimits};

#[derive(Debug, Clone)]
pub struct TablePage {
    pub metadata: TableMetadata,
    pub result: GridQueryResult,
    pub limit: usize,
    pub offset: u64,
    pub order_by: Vec<String>,
    pub has_more: bool,
}
pub(super) fn validate_request(table: &TableRef, limit: usize, offset: u64) -> Result<(), CatalogError> {
    metadata::validate_name(&table.namespace)?;
    metadata::validate_name(&table.name)?;
    if !(1..=1000).contains(&limit) || offset > 1_000_000 {
        return Err("table_page_invalid: limit requires 1..1000 and offset 0..1000000".into());
    }
    Ok(())
}
pub(super) fn quote(value: &str, dialect: &str) -> Result<String, CatalogError> {
    let mark = match dialect {
        "mysql" => '`',
        "postgres" | "sqlite" => '"',
        _ => return Err("internal: the catalog reads no other dialect".into()),
    };
    Ok(format!("{mark}{}{mark}", value.replace(mark, &format!("{mark}{mark}"))))
}
pub(super) async fn read(
    connection: &mut Conn,
    dialect: &str,
    server: polyspec_orm_schema::dbspec::Server,
    table: &TableRef,
    limit: usize,
    offset: u64,
) -> Result<TablePage, CatalogError> {
    let metadata = metadata::describe(connection, dialect, server, table).await?;
    if metadata.columns.is_empty() {
        return Err("table_page_unsupported: relation has no selectable columns".into());
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
    read_only::validate(&sql, dialect).map_err(|error| error.to_string())?;
    let read = temporal::read_page(connection, &metadata, dialect, &sql, QueryLimits { max_rows: limit + 1, max_bytes: 8 * 1024 * 1024 }, limit).await;
    let (result, has_more) = match read {
        Ok(page) => page,
        // A column that went away during the read fails the statement: the descriptor tells that from any other failure.
        Err(error) if error.message().starts_with("catalog_limit") => return Err(error),
        Err(error) => {
            return match metadata::describe(connection, dialect, server, table).await {
                Ok(after) if after != metadata => Err("table_page_metadata_changed: descriptor changed during read".into()),
                _ => Err(error),
            };
        }
    };
    let after = metadata::describe(connection, dialect, server, table).await?;
    assemble(metadata, result, has_more, after, limit, offset)
}
fn assemble(
    metadata: TableMetadata,
    result: GridQueryResult,
    has_more: bool,
    after: TableMetadata,
    limit: usize,
    offset: u64,
) -> Result<TablePage, CatalogError> {
    if result.columns.len() != metadata.columns.len() || result.columns.iter().zip(&metadata.columns).any(|(actual, declared)| actual.name != declared.name) {
        return Err("table_page_metadata_changed: prepared columns differ from descriptor".into());
    }
    if after != metadata {
        return Err("table_page_metadata_changed: descriptor changed during read".into());
    }
    let order_by = metadata.primary_key.clone();
    Ok(TablePage { metadata, result, limit, offset, order_by, has_more })
}

#[cfg(test)]
#[path = "../../tests/unit/table_page_validation.rs"]
mod tests;
