//! Recover statement-owned AUTO_INCREMENT and server-resolved literal defaults.
use super::{
    mutation::{bind, cell, qualified},
    page::quote,
    row_snapshot, TableMetadata,
};
use crate::tool_db::{Conn, QueryLimits, P};

pub(super) async fn execute(connection: &mut Conn, metadata: &TableMetadata, sql: &str, values: &[(String, P)], params: &[P]) -> Result<Vec<P>, String> {
    let auto = metadata
        .primary_key
        .iter()
        .any(|name| metadata.columns.iter().any(|column| column.name == *name && column.automatic_key) && !values.iter().any(|(column, _)| column == name));
    let (affected, identity) = connection.mysql_insert(sql, params).await.map_err(|e| e.to_string())?;
    if affected != 1 || (auto && identity == 0) {
        return Err("ROW_WRITE_MISMATCH: insert acknowledgement mismatch".into());
    }
    let mut bound = Vec::new();
    let mut predicates = Vec::new();
    for name in &metadata.primary_key {
        let column = metadata.columns.iter().find(|column| column.name == *name).unwrap();
        let quoted = quote(name, "mysql")?;
        if let Some((_, value)) = values.iter().find(|(column, _)| column == name) {
            bound.push(value.clone());
            predicates.push(format!("{quoted}=?"));
        } else if column.automatic_key {
            let value = if column.native_type.to_ascii_lowercase().contains("unsigned") {
                P::Unsigned(identity)
            } else {
                P::I(i64::try_from(identity).map_err(|_| "ROW_WRITE_MISMATCH: signed identity overflow".to_owned())?)
            };
            bound.push(value);
            predicates.push(format!("{quoted}=?"));
        } else {
            // Only literal defaults reach this branch. DEFAULT(column) applies
            // the server's declared type, charset and default semantics.
            predicates.push(format!("{quoted}=DEFAULT({quoted})"));
        }
    }
    let columns = metadata.columns.iter().map(|column| quote(&column.name, "mysql")).collect::<Result<Vec<_>, _>>()?.join(",");
    let result = connection
        .grid_query_bounded(
            &format!("SELECT {columns} FROM {} WHERE {} LIMIT 2 FOR UPDATE", qualified(metadata, "mysql")?, predicates.join(" AND ")),
            &bound,
            QueryLimits { max_rows: 2, max_bytes: 8 * 1024 * 1024 },
        )
        .await
        .map_err(|e| e.to_string())?;
    row_snapshot::projection(metadata, &result)?;
    if result.rows.len() != 1 {
        return Err("ROW_WRITE_MISMATCH: expected one generated-key row".into());
    }
    row_snapshot::row(metadata, &result.rows[0])?;
    for (name, value) in values {
        let index = metadata.columns.iter().position(|column| column.name == *name).unwrap();
        if result.rows[0][index] != cell(value) {
            return Err("ROW_WRITE_MISMATCH: inserted values differ".into());
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
