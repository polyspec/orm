use super::{run_sqlite_row_lock_sequence, SqliteRowLockSequenceOps};
use crate::{codes, Error, Result};

struct FakeSequence {
    set_error: Option<Error>,
    primary_error: Option<Error>,
    restore_error: Option<Error>,
    calls: Vec<&'static str>,
}

impl SqliteRowLockSequenceOps for FakeSequence {
    async fn set_nowait(&mut self) -> Result<()> {
        self.calls.push("set-zero");
        match self.set_error.take() { Some(error) => Err(error), None => Ok(()) }
    }

    async fn take_row_lock(&mut self) -> Result<()> {
        self.calls.push("lock");
        match self.primary_error.take() { Some(error) => Err(error), None => Ok(()) }
    }

    async fn restore_timeout(&mut self) -> Result<()> {
        self.calls.push("restore");
        match self.restore_error.take() { Some(error) => Err(error), None => Ok(()) }
    }
}

fn lock_error() -> Error {
    Error::Engine { code: codes::LOCK_NOT_AVAILABLE.into(), msg: "busy".into() }
}

fn restore_error() -> Error {
    Error::Config("restore rejected".into())
}

#[tokio::test]
async fn production_nowait_sequence_preserves_both_errors_and_attempts_restore() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for (primary, restore) in [(false, false), (false, true), (true, false), (true, true)] {
        let mut sequence = FakeSequence {
            set_error: None,
            primary_error: primary.then(lock_error),
            restore_error: restore.then(restore_error),
            calls: Vec::new(),
        };
        let result = run_sqlite_row_lock_sequence(&mut sequence).await;
        assert_eq!(sequence.calls, ["set-zero", "lock", "restore"]);
        match (primary, restore, result) {
            (false, false, Ok(())) => {}
            (false, true, Err(Error::Config(message))) => assert_eq!(message, "restore rejected"),
            (true, false, Err(error)) => assert_eq!(error.code(), codes::LOCK_NOT_AVAILABLE),
            (true, true, Err(Error::Cleanup { primary, cleanup })) => {
                assert_eq!(primary.code(), codes::LOCK_NOT_AVAILABLE);
                assert_eq!(cleanup.len(), 1);
                assert_eq!(cleanup[0].code(), codes::CONFIG);
            }
            (_, _, other) => panic!("unexpected result: {other:?}"),
        }
    }
}

#[tokio::test]
async fn failed_nowait_setup_still_restores_and_skips_lock_attempt() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let mut sequence = FakeSequence {
        set_error: Some(Error::Engine { code: codes::CANCELED.into(), msg: "set zero failed".into() }),
        primary_error: None,
        restore_error: Some(restore_error()),
        calls: Vec::new(),
    };
    let result = run_sqlite_row_lock_sequence(&mut sequence).await;
    assert_eq!(sequence.calls, ["set-zero", "restore"]);
    assert_eq!(result.as_ref().unwrap_err().code(), codes::CANCELED);
    match result {
        Err(Error::Cleanup { primary, cleanup }) => {
            assert_eq!(primary.code(), codes::CANCELED);
            assert_eq!(cleanup.len(), 1);
            assert_eq!(cleanup[0].code(), codes::CONFIG);
        }
        other => panic!("unexpected result: {other:?}"),
    }
}
