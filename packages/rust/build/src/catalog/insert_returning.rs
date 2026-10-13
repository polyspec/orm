//! Bounded typed INSERT RETURNING identities on PostgreSQL/SQLite.
use super::{mutation::bind, page::quote, row_snapshot, TableMetadata};
use crate::tool_db::{Conn, QueryLimits, P};

pub(super) async fn execute(connection: &mut Conn, metadata: &TableMetadata, sql: &str, params: &[P], dialect: &str) -> Result<Vec<P>, String> {
    let returning = metadata.columns.iter().map(|column| quote(&column.name, dialect)).collect::<Result<Vec<_>, _>>()?.join(",");
    let result = super::temporal::read(
        connection,
        metadata,
        dialect,
        &format!("{sql} RETURNING {returning}"),
        params,
        QueryLimits { max_rows: 2, max_bytes: 8 * 1024 * 1024 },
    )
    .await?;
    row_snapshot::projection(metadata, &result)?;
    if result.rows.len() != 1 {
        return Err("ROW_WRITE_MISMATCH: expected one returned insert row".into());
    }
    row_snapshot::row(metadata, &result.rows[0])?;
    metadata
        .primary_key
        .iter()
        .map(|name| {
            let index = metadata.columns.iter().position(|column| column.name == *name).unwrap();
            bind(&result.rows[0][index])
        })
        .collect::<Result<Vec<_>, _>>()
}
