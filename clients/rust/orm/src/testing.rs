//! The test entry point of the Rust client. The crate compiles this module
//! only with the feature `test-faults`, which no default feature enables.

use std::sync::atomic::Ordering;

use crate::Db;

/// Arms a test fault on the connection of `db` and on every clone of it. The
/// next rollback of a transaction whose callback failed runs, and then
/// reports a `FAULT` error as its rollback error, so the transaction returns
/// `Error::Rollback` (or `TransactionOnceError::Rollback`) with the callback
/// error and the fault. The fault stays armed until such a rollback consumes
/// it.
pub fn fail_next_rollback(db: &Db) {
    db.inner.rollback_fault.store(true, Ordering::Release);
}
