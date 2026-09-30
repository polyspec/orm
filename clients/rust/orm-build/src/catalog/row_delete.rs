//! Delete an exact checked original row under an owning transaction.
use super::{
    metadata,
    mutation::{bind, cancelled, lookup, mysql_safety, predicate, qualified, Publisher},
    mutation_finish, CatalogConnection, MutationPhase, RowSnapshot,
};
use crate::tool_db::{self, Conn};
use std::sync::{atomic::AtomicBool, Arc};

impl CatalogConnection {
    pub async fn delete_row(&self, original: &RowSnapshot, cancellation: Arc<AtomicBool>, publish: Publisher) -> Result<u64, String> {
        cancelled(&cancellation)?;
        let keys = original.key().map(|(_, value)| bind(value)).collect::<Result<Vec<_>, _>>()?;
        tool_db::validate_params(&keys, &self.dialect).map_err(|e| e.to_string())?;
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
            let current = lookup(&mut connection, original.metadata(), &self.dialect, &keys, true).await?;
            let descriptor = metadata::describe(&mut connection, &self.dialect, &original.metadata().table).await?;
            original.check_current(&descriptor, &current)?;
            if self.dialect == "mysql" {
                mysql_safety(&mut connection, &descriptor).await?;
            }
            publish(MutationPhase::Locked);
            cancelled(&cancellation)?;
            let sql = format!("DELETE FROM {} WHERE {}", qualified(&descriptor, &self.dialect)?, predicate(&descriptor, &self.dialect, 1)?);
            let affected = connection.exec(&sql, &keys).await.map_err(|e| e.to_string())?;
            if affected != 1 {
                return Err("ROW_WRITE_MISMATCH: expected exactly one deleted row".into());
            }
            publish(MutationPhase::Applied);
            cancelled(&cancellation)?;
            let after = lookup(&mut connection, &descriptor, &self.dialect, &keys, false).await?;
            let after_descriptor = metadata::describe(&mut connection, &self.dialect, &descriptor.table).await?;
            if descriptor != after_descriptor {
                return Err("ROW_SCHEMA_CHANGED: original descriptor changed".into());
            }
            if !after.rows.is_empty() {
                return Err("ROW_WRITE_MISMATCH: deleted row remains".into());
            }
            cancelled(&cancellation)?;
            Ok(affected)
        }
        .await;
        mutation_finish::finish(connection, result, publish).await
    }
}
