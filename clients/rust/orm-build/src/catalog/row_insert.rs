//! Explicit-key insertion. Automatic identities require a separate contract.
use super::{
    metadata,
    mutation::{cancelled, cell, lookup, mysql_safety, placeholder, qualified, Publisher},
    mutation_finish,
    page::quote,
    row_snapshot, CatalogConnection, MutationPhase, TableMetadata,
};
use crate::tool_db::{self, Conn, GridQueryResult, P};
use std::{
    collections::HashSet,
    sync::{atomic::AtomicBool, Arc},
};

fn validate(metadata: &TableMetadata, values: &[(String, P)], dialect: &str) -> Result<Vec<P>, String> {
    row_snapshot::descriptor(metadata)?;
    if values.is_empty() || values.len() > metadata.columns.len() {
        return Err("ROW_INSERT_INVALID: invalid assignments".into());
    }
    tool_db::validate_param_refs(values.iter().map(|(_, value)| value), dialect).map_err(|e| e.to_string())?;
    let mut names = HashSet::new();
    let mut bytes = 0usize;
    for (name, value) in values {
        let column = metadata.columns.iter().find(|column| column.name == *name).ok_or_else(|| "ROW_INSERT_INVALID: unknown column".to_owned())?;
        if !names.insert(name) || column.generated || (!column.nullable && matches!(value, P::Null(_))) {
            return Err("ROW_INSERT_INVALID: invalid column assignment".into());
        }
        let size = match value {
            P::S(v) | P::Decimal(v) => v.len(),
            P::Binary(v) => v.len(),
            _ => 16,
        };
        bytes = bytes
            .checked_add(name.len())
            .and_then(|n| n.checked_add(size))
            .filter(|n| *n <= 8 * 1024 * 1024)
            .ok_or_else(|| "ROW_INSERT_LIMIT: assignment budget exceeded".to_owned())?;
    }
    let keys = metadata
        .primary_key
        .iter()
        .map(|name| {
            values
                .iter()
                .find(|(column, _)| column == name)
                .map(|(_, value)| value.clone())
                .ok_or_else(|| "ROW_INSERT_IDENTITY_REQUIRED: explicit primary key required".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let params = values.iter().map(|(_, value)| value.clone()).collect::<Vec<_>>();
    tool_db::validate_params(&params, dialect).map_err(|e| e.to_string())?;
    let cells = params.iter().map(cell).collect::<Vec<_>>();
    row_snapshot::revision(metadata, &cells).map_err(|_| "ROW_INSERT_LIMIT: assignment encoding budget exceeded".to_owned())?;
    Ok(keys)
}
impl CatalogConnection {
    /// Insert with explicit primary-key values, never guessed generated identity.
    pub async fn insert_row(
        &self,
        declared: &TableMetadata,
        values: &[(String, P)],
        cancellation: Arc<AtomicBool>,
        publish: Publisher,
    ) -> Result<GridQueryResult, String> {
        cancelled(&cancellation)?;
        let keys = validate(declared, values, &self.dialect)?;
        publish(MutationPhase::Validated);
        cancelled(&cancellation)?;
        let mut connection = Conn::acquire(&self.pool).await.map_err(|e| e.to_string())?;
        connection.discard_on_drop();
        cancelled(&cancellation)?;
        connection
            .exec(
                match self.dialect.as_str() {
                    "mysql" => "START TRANSACTION",
                    "postgres" => "BEGIN",
                    _ => "BEGIN IMMEDIATE",
                },
                &[],
            )
            .await
            .map_err(|e| e.to_string())?;
        let result = async {
            cancelled(&cancellation)?;
            let existing = lookup(&mut connection, declared, &self.dialect, &keys, true).await?;
            let descriptor = metadata::describe(&mut connection, &self.dialect, &declared.table).await?;
            if &descriptor != declared {
                return Err("ROW_SCHEMA_CHANGED: insertion descriptor changed".into());
            }
            if !existing.rows.is_empty() {
                return Err("ROW_CONFLICT: insertion key already exists".into());
            }
            if self.dialect == "mysql" {
                mysql_safety(&mut connection, &descriptor).await?;
            }
            publish(MutationPhase::Locked);
            cancelled(&cancellation)?;
            let names = values.iter().map(|(name, _)| quote(name, &self.dialect)).collect::<Result<Vec<_>, _>>()?.join(",");
            let slots = (1..=values.len()).map(|index| placeholder(index, &self.dialect)).collect::<Vec<_>>().join(",");
            let sql = format!("INSERT INTO {}({names}) VALUES({slots})", qualified(&descriptor, &self.dialect)?);
            let params = values.iter().map(|(_, value)| value.clone()).collect::<Vec<_>>();
            let affected = connection.exec(&sql, &params).await.map_err(|e| e.to_string())?;
            if affected != 1 {
                return Err("ROW_WRITE_MISMATCH: expected exactly one inserted row".into());
            }
            publish(MutationPhase::Applied);
            cancelled(&cancellation)?;
            let after = lookup(&mut connection, &descriptor, &self.dialect, &keys, false).await?;
            let after_descriptor = metadata::describe(&mut connection, &self.dialect, &descriptor.table).await?;
            if descriptor != after_descriptor {
                return Err("ROW_SCHEMA_CHANGED: insertion descriptor changed".into());
            }
            row_snapshot::projection(&descriptor, &after)?;
            if after.rows.len() != 1 {
                return Err("ROW_WRITE_MISMATCH: expected exactly one inserted row".into());
            }
            row_snapshot::row(&descriptor, &after.rows[0])?;
            row_snapshot::revision(&descriptor, &after.rows[0])?;
            for (name, value) in values {
                let index = descriptor.columns.iter().position(|column| column.name == *name).ok_or_else(|| "ROW_INSERT_INVALID: unknown column".to_owned())?;
                if after.rows[0][index] != cell(value) {
                    return Err("ROW_WRITE_MISMATCH: stored inserted values differ".into());
                }
            }
            cancelled(&cancellation)?;
            Ok(after)
        }
        .await;
        mutation_finish::finish(connection, result, publish).await
    }
}
