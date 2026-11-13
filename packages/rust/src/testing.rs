//! The test entry point of the Rust client. The crate compiles this module only when feature `test-faults`
//! is present, and no default feature enables it.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use tokio::sync::Notify;

use crate::Db;
use crate::Error;

pub mod ir_request;

/// The uses of each parameter of a validated request as the JSON of the ir.param_uses op (docs/spec/feature-coverage.md FCV-4).
pub fn param_uses(manifest: &crate::schema::Manifest, request: &crate::ir::Request) -> crate::Result<serde_json::Value> {
    use polyspec_orm_schema::dbspec::Type;
    let uses = crate::engine::param_uses(manifest, request)?;
    Ok(serde_json::Value::Array(
        uses.iter()
            .map(|parameter| {
                serde_json::Value::Array(
                    parameter
                        .iter()
                        .map(|use_| match use_.column {
                            None => serde_json::json!({"type": use_.ty}),
                            Some(field) => {
                                let (length, precision, scale): (u32, u32, u32) = match field.ty {
                                    Type::Varchar(n) => (n.into(), 0, 0),
                                    Type::Decimal(p, s) => (0, p.into(), s.into()),
                                    Type::Time(p) | Type::DateTime(p) => (0, p.into(), 0),
                                    _ => (0, 0, 0),
                                };
                                let mut out = serde_json::json!({"type": use_.ty, "column": field.name, "length": length, "null": field.nullable, "precision": precision, "scale": scale});
                                if use_.assign {
                                    out["assign"] = serde_json::json!(true);
                                }
                                out
                            }
                        })
                        .collect(),
                )
            })
            .collect(),
    ))
}

/// Compiles a request built from a generated model without opening a database connection.
/// This is available only with `test-faults`, for database-independent planner tests.
pub fn compile_core_request(core: &crate::Core, kind: &str, dialect: crate::Dialect) -> crate::Result<crate::plan::Plan> {
    let request = crate::request::build(core, kind);
    if let Some(error) = request.error() {
        return Err(error);
    }
    let manifest = request.schema.manifest()?;
    crate::engine::validate(&manifest, &request.ir)?;
    crate::request::validate_page_params(&request.ir, &request.params)?;
    crate::engine::compile(&manifest, dialect, &request.ir)
}

/// Sets a test fault on the connection of `db` and all its clones. After a callback fails,
/// the next transaction's rollback, once run, reports a `FAULT` error as the rollback error
/// so the transaction returns an `Error::Rollback` carrying the callback error and the fault
/// (or `TransactionOnceError::Rollback`). The fault remains until such a rollback
/// consumes it.
pub fn fail_next_rollback(db: &Db) {
    db.inner.rollback_fault.store(true, Ordering::Release);
}

/// The statement fault of a connection: the code and the message of the error
/// that the next statement ends with.
pub(crate) struct StatementFault {
    kind: crate::Kind,
    message: String,
}

/// Sets the test fault of the next statement on the connection of `db` and all its clones. The next
/// statement is not sent to the database and ends with an ORM error of `kind` and `message`. A transaction
/// control statement does not consume this fault. An already configured statement fault is replaced.
///
/// If `message` is empty, it panics and sets nothing.
pub fn fail_next_statement(db: &Db, kind: crate::Kind, message: &str) {
    assert!(!message.is_empty(), "fail_next_statement: the message is empty");
    let fault = StatementFault { kind, message: message.to_owned() };
    *db.inner.statement_fault.lock().unwrap() = Some(fault);
}

/// An error of a failed SQLite statement with the result code `result` and the text `message`, as the client reads the error of
/// the SQLite driver: its code is the result code as text and its kind follows that code (PRT-71). The error states no code of
/// the error catalog, so the client maps it from its result code alone.
pub fn sqlite_result_error(message: &str, result: i64) -> sqlx::Error {
    sqlx::Error::Database(Box::new(crate::markdown::MarkdownServerError { code: String::new(), message: message.to_owned(), result: Some(result) }))
}

/// Consumes the configured statement fault of `db` and returns its error. None if there is no fault.
pub(crate) fn take_statement_fault(db: &Db) -> Option<Error> {
    let fault = db.inner.statement_fault.lock().unwrap().take()?;
    Some(Error::new(fault.kind, fault.message))
}

/// The statement gate of a connection: the next statement on one of its transactions waits there, holding the
/// transaction connection, until the test releases it.
pub(crate) struct StatementGate {
    reached: Arc<Notify>,
    release: Arc<Notify>,
}

/// The test side of a statement gate set by `hold_next_statement`.
pub struct StatementHold {
    reached: Arc<Notify>,
    release: Arc<Notify>,
}

/// Holds the next statement that runs on a transaction of the connection of `db` and all its clones. The statement
/// takes the transaction connection as every statement does, and then waits there until `StatementHold::release`, so
/// a second statement of the same transaction is refused with CONFIG for as long as the first one waits. A statement
/// outside a transaction does not consume the gate. An already set gate is replaced.
pub fn hold_next_statement(db: &Db) -> StatementHold {
    let reached = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let gate = StatementGate { reached: Arc::clone(&reached), release: Arc::clone(&release) };
    *db.inner.statement_gate.lock().unwrap() = Some(gate);
    StatementHold { reached, release }
}

impl StatementHold {
    /// Waits until the held statement has reached the hold, so it holds the transaction connection from then on.
    pub async fn reached(&self) {
        self.reached.notified().await;
    }

    /// Lets the held statement continue.
    pub fn release(&self) {
        self.release.notify_one();
    }
}

/// Takes the gate of `db`, if one is set, and waits at it while the calling statement holds the transaction connection.
pub(crate) async fn wait_at_statement_gate(db: &Db) {
    let gate = db.inner.statement_gate.lock().unwrap().take();
    if let Some(gate) = gate {
        gate.reached.notify_one();
        gate.release.notified().await;
    }
}

/// Pins the executor clock of the connection of `db` and all its clones to the time `clock`. `clock` is UTC
/// `YYYY-MM-DD HH:MM:SS.ffffff` text (docs/spec/protocol.md "Test clock").
///
/// If the format differs, it panics and sets nothing.
pub fn fix_clock(db: &Db, clock: &str) {
    let parsed = chrono::NaiveDateTime::parse_from_str(clock, "%Y-%m-%d %H:%M:%S%.6f");
    assert!(parsed.is_ok() && clock.len() == 26, "fix_clock: the clock is not YYYY-MM-DD HH:MM:SS.ffffff");
    *db.inner.fixed_clock.lock().unwrap() = Some(clock.to_owned());
}

/// The affected count of the last successful write result on the connection of `db` and all its clones. If no successful write
/// has occurred, it is None (docs/spec/protocol.md "Test write result").
pub fn last_affected(db: &Db) -> Option<u64> {
    *db.inner.last_affected.lock().unwrap()
}
