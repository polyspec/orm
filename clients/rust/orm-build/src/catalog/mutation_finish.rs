//! Shared writable transaction acknowledgement, never automatic retry.
use super::mutation::{MutationPhase, Publisher};
use crate::tool_db::Conn;

pub(super) async fn finish<T: Send + 'static>(mut connection: Conn, result: Result<T, String>, publish: Publisher) -> Result<T, String> {
    let value = match result {
        Ok(value) => value,
        Err(error) => {
            if connection.exec("ROLLBACK", &[]).await.is_err() {
                publish(MutationPhase::Indeterminate);
                return Err("ROW_ROLLBACK_FAILED: rollback acknowledgement failed".into());
            }
            publish(MutationPhase::RolledBack);
            return Err(error);
        }
    };
    // No cancellation await between publishing intent and spawning its owner.
    publish(MutationPhase::CommitStarted);
    let task = tokio::spawn(async move {
        match connection.exec("COMMIT", &[]).await {
            Ok(_) => {
                publish(MutationPhase::Committed);
                Ok(value)
            }
            Err(error) if explicitly_rejected(&error) => {
                if connection.exec("ROLLBACK", &[]).await.is_err() {
                    publish(MutationPhase::Indeterminate);
                    return Err(format!("ROW_COMMIT_INDETERMINATE: rejection cleanup unconfirmed; do not retry: {error}"));
                }
                publish(MutationPhase::RolledBack);
                Err(format!("ROW_COMMIT_REJECTED: native commit rejected: {error}"))
            }
            Err(error) => {
                publish(MutationPhase::Indeterminate);
                Err(format!("ROW_COMMIT_INDETERMINATE: commit outcome unknown; do not retry: {error}"))
            }
        }
    });
    task.await.map_err(|_| "ROW_COMMIT_INDETERMINATE: commit owner interrupted; do not retry".to_owned())?
}
fn explicitly_rejected(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(|error| error.try_downcast_ref::<sqlx::postgres::PgDatabaseError>())
        .is_some_and(|error| error.code().starts_with("23") || error.code().starts_with("40"))
}

#[cfg(test)]
#[path = "../../tests/unit/mutation_commit.rs"]
mod tests;
