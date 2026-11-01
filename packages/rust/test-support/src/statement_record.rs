//! Serializes the common statement-event fields emitted by Rust test runners.

use polyspec_orm::StatementEvent;
use serde_json::Value;

/// Builds the shared event JSON after the caller normalizes binds and transaction numbers.
pub fn statement_record(event: &StatementEvent<'_>, binds: Vec<Value>, transaction: Option<u64>) -> Value {
    serde_json::json!({
        "sql": event.sql,
        "binds": binds,
        "kind": event.kind,
        "tables": event.tables,
        "transaction": transaction,
        "error": event.error.map(|error| error.code().to_owned()),
    })
}
