//! Shared writable transaction acknowledgement, never automatic retry.
use super::mutation::{CommitPermit, MutationPhase, Publisher};
use super::CatalogError;
use crate::tool_db::Conn;

pub(super) async fn finish<T: Send + 'static>(
    mut connection: Conn,
    result: Result<T, CatalogError>,
    publish: Publisher,
    permit: CommitPermit,
) -> Result<T, CatalogError> {
    let result = result.and_then(|value| permit().map(|()| value).map_err(|error| CatalogError::from(format!("ROW_COMMIT_PERMIT_FAILED: {error}"))));
    let value = match result {
        Ok(value) => value,
        Err(error) => {
            if connection.rollback().await.is_err() {
                publish(MutationPhase::Indeterminate);
                return Err("row_rollback_failed: rollback acknowledgement failed".into());
            }
            publish(MutationPhase::RolledBack);
            return Err(error);
        }
    };
    // No cancellation await between publishing intent and spawning its owner.
    publish(MutationPhase::CommitStarted);
    // Under feature test-faults the spawned commit answers from the test script of its caller (T431).
    #[cfg(feature = "test-faults")]
    let spawn = |body| tokio::spawn(crate::tool_db::script::carry(body));
    #[cfg(not(feature = "test-faults"))]
    let spawn = tokio::spawn;
    let task = spawn(async move {
        match connection.exec("COMMIT", &[]).await {
            Ok(_) => {
                // The commit ended the transaction and its locks, so the next mutation of this catalog takes this connection. Every
                // other end leaves the mark of `discard_on_drop`: a connection whose transaction may still be open never returns.
                connection.return_to_pool().await;
                publish(MutationPhase::Committed);
                Ok(value)
            }
            Err(error) if explicitly_rejected(&error) => {
                if connection.rollback().await.is_err() {
                    publish(MutationPhase::Indeterminate);
                    return Err(format!("row_commit_indeterminate: rejection cleanup unconfirmed; do not retry: {error}").into());
                }
                publish(MutationPhase::RolledBack);
                Err(format!("row_commit_rejected: native commit rejected: {error}").into())
            }
            Err(error) => {
                publish(MutationPhase::Indeterminate);
                Err(format!("row_commit_indeterminate: commit outcome unknown; do not retry: {error}").into())
            }
        }
    });
    task.await.map_err(|error| format!("row_commit_indeterminate: commit owner interrupted; do not retry: {error}"))?
}
fn explicitly_rejected(error: &sqlx::Error) -> bool {
    // A constraint that the server checks at the commit rejects the commit on every database.
    if error.as_database_error().is_some_and(|error| !matches!(error.kind(), sqlx::error::ErrorKind::Other)) {
        return true;
    }
    // A deadlock that a flowmark server reports at the commit rolled the transaction back, as PostgreSQL's class 40 does.
    if error
        .as_database_error()
        .and_then(|error| error.try_downcast_ref::<polyspec_orm::markdown::MarkdownServerError>())
        .is_some_and(|error| error.code() == "DEADLOCK")
    {
        return true;
    }
    error
        .as_database_error()
        .and_then(|error| error.try_downcast_ref::<sqlx::postgres::PgDatabaseError>())
        .is_some_and(|error| error.code().starts_with("23") || error.code().starts_with("40"))
}

#[cfg(test)]
#[path = "../../tests/unit/mutation_commit.rs"]
mod tests;
