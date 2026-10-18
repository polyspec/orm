//! The test entry point of the Rust client. The crate compiles this module only when feature `test-faults`
//! is present, and no default feature enables it.

use std::sync::atomic::Ordering;

use crate::Db;
use crate::Error;

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
    code: String,
    message: String,
}

/// Sets the test fault of the next statement on the connection of `db` and all its clones. The next
/// statement is not sent to the database and ends with an ORM error of `code` and `message`. A transaction
/// control statement does not consume this fault. An already configured statement fault is replaced.
///
/// If `code` or `message` is empty, it panics and sets nothing.
pub fn fail_next_statement(db: &Db, code: &str, message: &str) {
    assert!(!code.is_empty(), "fail_next_statement: the code is empty");
    assert!(!message.is_empty(), "fail_next_statement: the message is empty");
    let fault = StatementFault { code: code.to_owned(), message: message.to_owned() };
    *db.inner.statement_fault.lock().unwrap() = Some(fault);
}

/// Consumes the configured statement fault of `db` and returns its error. None if there is no fault.
pub(crate) fn take_statement_fault(db: &Db) -> Option<Error> {
    let fault = db.inner.statement_fault.lock().unwrap().take()?;
    Some(Error::Engine { code: fault.code, msg: fault.message })
}

/// Pins the executor clock of the connection of `db` and all its clones to the time `clock`. `clock` is UTC
/// `YYYY-MM-DD HH:MM:SS.ffffff` text (docs/protocol.md "Test clock").
///
/// If the format differs, it panics and sets nothing.
pub fn fix_clock(db: &Db, clock: &str) {
    let parsed = chrono::NaiveDateTime::parse_from_str(clock, "%Y-%m-%d %H:%M:%S%.6f");
    assert!(parsed.is_ok() && clock.len() == 26, "fix_clock: the clock is not YYYY-MM-DD HH:MM:SS.ffffff");
    *db.inner.fixed_clock.lock().unwrap() = Some(clock.to_owned());
}

/// The affected count of the last successful write result on the connection of `db` and all its clones. If no successful write
/// has occurred, it is None (docs/protocol.md "Test write result").
pub fn last_affected(db: &Db) -> Option<u64> {
    *db.inner.last_affected.lock().unwrap()
}
