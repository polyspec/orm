//! Rust client의 test entry point다. crate는 이 module을 feature `test-faults`가
//! 있을 때만 compile하며, 어떤 default feature도 그것을 켜지 않는다.

use std::sync::atomic::Ordering;

use crate::Db;

/// `db`의 connection과 그 모든 clone에 test fault를 설정한다. callback이 실패한
/// 다음 transaction의 rollback은 실행된 뒤 rollback 오류로 `FAULT` 오류를
/// 보고하므로, transaction은 callback 오류와 fault를 가진 `Error::Rollback`
/// (또는 `TransactionOnceError::Rollback`)을 반환한다. fault는 그런 rollback이
/// 소비할 때까지 남는다.
pub fn fail_next_rollback(db: &Db) {
    db.inner.rollback_fault.store(true, Ordering::Release);
}
