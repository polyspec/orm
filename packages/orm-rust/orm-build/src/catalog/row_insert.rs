//! Typed insertion with database-owned generated identities.
use super::{
    metadata,
    mutation::{cancelled, cell, lookup, mysql_safety, placeholder, qualified, CommitPermit, Publisher},
    mutation_finish,
    page::quote,
    row_snapshot, CatalogConnection, MutationPhase, TableMetadata,
};
use crate::tool_db::{Conn, GridQueryResult, QueryLimits, P};
use std::sync::{atomic::AtomicBool, Arc};

#[cfg(test)]
#[path = "../../tests/unit/row_insert_lock.rs"]
mod lock_tests;

/// The statement that takes, on PostgreSQL, the lock an INSERT takes (ROW EXCLUSIVE) on the declared table. It
/// conflicts with every schema change, which needs ACCESS EXCLUSIVE.
fn postgres_insert_lock(declared: &TableMetadata) -> Result<String, String> {
    Ok(format!("LOCK TABLE {} IN ROW EXCLUSIVE MODE", qualified(declared, "postgres")?))
}

impl CatalogConnection {
    /// Insert with explicit or database-returned primary-key values, never guessed.
    pub async fn insert_row(
        &self,
        declared: &TableMetadata,
        values: &[(String, P)],
        cancellation: Arc<AtomicBool>,
        publish: Publisher,
        permit: CommitPermit,
    ) -> Result<GridQueryResult, String> {
        cancelled(&cancellation)?;
        let keys = super::insert_values::validate(declared, values, &self.dialect)?;
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
            if self.dialect == "mysql" && keys.is_none() {
                // Information-schema reads alone do not retain the target's
                // metadata lock. Acquire it before checking engine or schema.
                connection
                    .grid_query_bounded(
                        &format!("SELECT 1 FROM {} LIMIT 0 FOR UPDATE", qualified(declared, "mysql")?),
                        &[],
                        QueryLimits { max_rows: 1, max_bytes: 65536 },
                    )
                    .await
                    .map_err(|error| error.to_string())?;
            }
            if self.dialect == "postgres" {
                // The catalog reads of describe take no lock on PostgreSQL. Take the lock that the insert itself
                // takes before checking the schema, so no DDL changes the table between the check and the write,
                // and Locked is published only while it is held.
                connection.exec(&postgres_insert_lock(declared)?, &[]).await.map_err(|error| error.to_string())?;
            }
            if let Some(keys) = &keys {
                let existing = lookup(&mut connection, declared, &self.dialect, keys, true).await?;
                if !existing.rows.is_empty() {
                    return Err("ROW_CONFLICT: insertion key already exists".into());
                }
            }
            let descriptor = metadata::describe(&mut connection, &self.dialect, &declared.table).await?;
            if &descriptor != declared {
                return Err("ROW_SCHEMA_CHANGED: insertion descriptor changed".into());
            }
            if self.dialect == "mysql" {
                mysql_safety(&mut connection, &descriptor).await?;
            }
            // Select this strategy from metadata before any write, not by
            // catching failure from another returning path.
            let locator = if self.dialect == "mysql"
                && keys.is_none()
                && descriptor.primary_key.iter().any(|name| {
                    !values.iter().any(|(column, _)| column == name)
                        && descriptor.columns.iter().any(|column| column.name == *name && column.expression_default)
                }) {
                let locator = super::insert_mysql_locator::Locator::new(&descriptor, values)?;
                locator.require_absent(&mut connection).await?;
                Some(locator)
            } else {
                None
            };
            publish(MutationPhase::Locked);
            cancelled(&cancellation)?;
            let names = values.iter().map(|(name, _)| quote(name, &self.dialect)).collect::<Result<Vec<_>, _>>()?.join(",");
            let slots = (1..=values.len()).map(|index| placeholder(index, &self.dialect)).collect::<Vec<_>>().join(",");
            let sql = if values.is_empty() {
                if self.dialect == "mysql" {
                    format!("INSERT INTO {}() VALUES()", qualified(&descriptor, &self.dialect)?)
                } else {
                    format!("INSERT INTO {} DEFAULT VALUES", qualified(&descriptor, &self.dialect)?)
                }
            } else {
                format!("INSERT INTO {}({names}) VALUES({slots})", qualified(&descriptor, &self.dialect)?)
            };
            let params = values.iter().map(|(_, value)| value.clone()).collect::<Vec<_>>();
            let keys = if let Some(keys) = keys {
                let affected = connection.exec(&sql, &params).await.map_err(|e| e.to_string())?;
                if affected != 1 {
                    return Err("ROW_WRITE_MISMATCH: expected exactly one inserted row".into());
                }
                keys
            } else if let Some(locator) = locator {
                let affected = connection.exec(&sql, &params).await.map_err(|error| error.to_string())?;
                if affected != 1 {
                    return Err("ROW_WRITE_MISMATCH: expected exactly one inserted row".into());
                }
                locator.returned_keys(&mut connection, &descriptor, values).await?
            } else if self.dialect == "mysql" {
                super::insert_mysql_identity::execute(&mut connection, &descriptor, &sql, values, &params).await?
            } else {
                super::insert_returning::execute(&mut connection, &descriptor, &sql, &params, &self.dialect).await?
            };
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
        mutation_finish::finish(connection, result, publish, permit).await
    }
}
