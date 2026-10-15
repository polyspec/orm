//! Rust client의 test entry point다. crate는 이 module을 feature `test-faults`가
//! 있을 때만 compile하며, 어떤 default feature도 그것을 켜지 않는다.

use std::sync::atomic::Ordering;

use crate::Db;
use crate::Error;

/// `db`의 connection과 그 모든 clone에 test fault를 설정한다. callback이 실패한
/// 다음 transaction의 rollback은 실행된 뒤 rollback 오류로 `FAULT` 오류를
/// 보고하므로, transaction은 callback 오류와 fault를 가진 `Error::Rollback`
/// (또는 `TransactionOnceError::Rollback`)을 반환한다. fault는 그런 rollback이
/// 소비할 때까지 남는다.
pub fn fail_next_rollback(db: &Db) {
    db.inner.rollback_fault.store(true, Ordering::Release);
}

/// The statement fault of a connection: the code and the message of the error
/// that the next statement ends with.
pub(crate) struct StatementFault {
    code: String,
    message: String,
}

/// `db`의 connection과 그 모든 clone에 다음 statement의 test fault를 설정한다. 다음
/// statement는 database로 보내지 않고 `code`와 `message`의 ORM 오류로 끝난다. transaction
/// 제어 statement는 이 fault를 소비하지 않는다. 이미 설정된 statement fault는 바뀐다.
///
/// `code`나 `message`가 비었으면 panic하고 아무것도 설정하지 않는다.
pub fn fail_next_statement(db: &Db, code: &str, message: &str) {
    assert!(!code.is_empty(), "fail_next_statement: the code is empty");
    assert!(!message.is_empty(), "fail_next_statement: the message is empty");
    let fault = StatementFault { code: code.to_owned(), message: message.to_owned() };
    *db.inner.statement_fault.lock().unwrap() = Some(fault);
}

/// `db`의 설정된 statement fault를 소비하고 그 오류를 돌려준다. fault가 없으면 None이다.
pub(crate) fn take_statement_fault(db: &Db) -> Option<Error> {
    let fault = db.inner.statement_fault.lock().unwrap().take()?;
    Some(Error::Engine { code: fault.code, msg: fault.message })
}

/// `db`의 connection과 그 모든 clone의 executor clock을 `clock` 시각으로 고정한다. `clock`은 UTC의
/// `YYYY-MM-DD HH:MM:SS.ffffff` text다(docs/protocol.md "Test clock").
///
/// 형식이 다르면 panic하고 아무것도 설정하지 않는다.
pub fn fix_clock(db: &Db, clock: &str) {
    let parsed = chrono::NaiveDateTime::parse_from_str(clock, "%Y-%m-%d %H:%M:%S%.6f");
    assert!(parsed.is_ok() && clock.len() == 26, "fix_clock: the clock is not YYYY-MM-DD HH:MM:SS.ffffff");
    *db.inner.fixed_clock.lock().unwrap() = Some(clock.to_owned());
}

/// `db`의 connection과 그 모든 clone에서 마지막으로 성공한 write 결과의 affected다. 성공한 write가
/// 없었으면 None이다(docs/protocol.md "Test write result").
pub fn last_affected(db: &Db) -> Option<u64> {
    *db.inner.last_affected.lock().unwrap()
}
