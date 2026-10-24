//! Delete an exact checked original row under an owning transaction.
use super::{
    metadata,
    mutation::{begin_mutation, cancelled, lock_original, lookup, predicate, qualified, validated_keys, CommitPermit, Publisher},
    mutation_finish, CatalogConnection, MutationPhase, RowSnapshot,
};
use std::sync::{atomic::AtomicBool, Arc};

impl CatalogConnection {
    pub async fn delete_row(&self, original: &RowSnapshot, cancellation: Arc<AtomicBool>, publish: Publisher, permit: CommitPermit) -> Result<u64, String> {
        cancelled(&cancellation)?;
        let keys = validated_keys(original, &self.dialect)?;
        publish(MutationPhase::Validated);
        let mut connection = begin_mutation(&self.pool, &self.dialect, &cancellation).await?;
        let result = async {
            let descriptor = lock_original(&mut connection, original, &self.dialect, &keys, &cancellation, &publish).await?;
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
        mutation_finish::finish(connection, result, publish, permit).await
    }
}
