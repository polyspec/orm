//! Explicit transactional input locator for unreturned expression-default keys.
//! No key/default evaluation, schema changes or automatic retry.
use super::{
    mutation::{bind, cell, qualified},
    page::quote,
    row_snapshot, TableMetadata,
};
use crate::tool_db::{Conn, GridQueryResult, QueryLimits, P};

pub(super) struct Locator {
    sql: String,
    params: Vec<P>,
}
impl Locator {
    pub(super) fn new(metadata: &TableMetadata, values: &[(String, P)]) -> Result<Self, String> {
        let mut predicates = Vec::new();
        let mut params = Vec::new();
        for (name, value) in values {
            let column = quote(name, "mysql")?;
            if matches!(value, P::Null(_)) {
                predicates.push(format!("{column} IS NULL"));
            } else {
                predicates.push(format!("{column}=?"));
                params.push(value.clone());
            }
        }
        let columns = metadata.columns.iter().map(|column| quote(&column.name, "mysql")).collect::<Result<Vec<_>, _>>()?.join(",");
        let predicate = if predicates.is_empty() { "1=1".into() } else { predicates.join(" AND ") };
        Ok(Self { sql: format!("SELECT {columns} FROM {} WHERE {predicate} LIMIT 2 FOR UPDATE", qualified(metadata, "mysql")?), params })
    }
    async fn read(&self, connection: &mut Conn) -> Result<GridQueryResult, String> {
        connection.grid_query_bounded(&self.sql, &self.params, QueryLimits { max_rows: 2, max_bytes: 8 * 1024 * 1024 }).await.map_err(|error| error.to_string())
    }
    pub(super) async fn require_absent(&self, connection: &mut Conn) -> Result<(), String> {
        if !self.read(connection).await?.rows.is_empty() {
            return Err("ROW_IDENTITY_AMBIGUOUS: generated identity locator already matches rows".into());
        }
        Ok(())
    }
    pub(super) async fn returned_keys(&self, connection: &mut Conn, metadata: &TableMetadata, values: &[(String, P)]) -> Result<Vec<P>, String> {
        let mut result = self.read(connection).await?;
        super::temporal::declared_precision(metadata, "mysql", &mut result)?;
        row_snapshot::projection(metadata, &result)?;
        if result.rows.len() != 1 {
            return Err("ROW_IDENTITY_AMBIGUOUS: expected exactly one inserted locator row".into());
        }
        row_snapshot::row(metadata, &result.rows[0])?;
        row_snapshot::revision(metadata, &result.rows[0])?;
        for (name, value) in values {
            let index = metadata.columns.iter().position(|column| column.name == *name).unwrap();
            if result.rows[0][index] != cell(value) {
                return Err("ROW_WRITE_MISMATCH: locator values differ from requested values".into());
            }
        }
        metadata
            .primary_key
            .iter()
            .map(|name| {
                let index = metadata.columns.iter().position(|column| column.name == *name).unwrap();
                bind(&result.rows[0][index])
            })
            .collect()
    }
}
