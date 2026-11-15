// The state machines of Db::transaction, Tx::savepoint and Db::close (CORE-100 to CORE-105). Each case drives a machine
// step by step as a binding does: it awaits each Io future on a runtime of its own, makes each call on its own thread,
// outside the runtime, and settles each awaited value. A callback runs its statements on that runtime, as a member of
// a blocking language does. The cases run on a SQLite file of their own.

use crate::db::Pool;
use crate::test_support::Scratch;
use crate::{Config, Db, Error, Kind, Param, TransactionOptions, Tx};
use binding_core::machine::{Machine, Step};
use binding_core::{Failure, Handle, Native, NativeObject, Passthrough, Raised};
use std::cell::RefCell;
use std::rc::Rc;
use tokio::runtime::Runtime;

type Outcome = Result<Passthrough, Failure<Error>>;

thread_local! {
    /// The handles of the values that the core released on this thread, in order.
    static RELEASED: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
}

fn release(handle: Handle) {
    RELEASED.with(|released| released.borrow_mut().push(handle.raw()));
}

fn released() -> Vec<u64> {
    RELEASED.with(|released| std::mem::take(&mut *released.borrow_mut()))
}

/// The value of language code that the table of this test holds under `handle`.
fn passed(handle: u64) -> Passthrough {
    Passthrough::from_generated(Handle::new(handle), release)
}

#[derive(Debug)]
struct Thrown(u64);

impl NativeObject for Thrown {}

fn raised(handle: u64) -> Raised {
    Raised::from_generated(Native::new(Thrown(handle)))
}

fn raised_id(raised: &Raised) -> Option<u64> {
    raised.native().downcast::<Thrown>().map(|thrown| thrown.0)
}

/// Drives `machine` to its end and gives the names of its steps with its result. `awaited` gives the outcome of each
/// awaited value, as the awaitable of a language does.
fn drive_with<M: Machine>(
    runtime: &Runtime,
    machine: &mut M,
    mut awaited: impl FnMut(Passthrough) -> Result<Passthrough, Raised>,
) -> (Vec<&'static str>, M::Done) {
    let mut steps = Vec::new();
    let mut io = None;
    loop {
        match machine.resume(io.take()) {
            Step::Io(future) => {
                steps.push("Io");
                io = Some(runtime.block_on(future));
            }
            Step::Call => {
                steps.push("Call");
                machine.call();
            }
            Step::Await(value) => {
                steps.push("Await");
                machine.settle(awaited(value));
            }
            Step::Done(done) => {
                steps.push("Done");
                return (steps, done);
            }
        }
    }
}

/// Drives `machine` as a language without an awaitable does: each awaited value is settled with itself.
fn drive<M: Machine>(runtime: &Runtime, machine: &mut M) -> (Vec<&'static str>, M::Done) {
    drive_with(runtime, machine, Ok)
}

fn once() -> TransactionOptions {
    TransactionOptions { retry: Some(0), ..TransactionOptions::default() }
}

/// A runtime and a SQLite database with the table `machine_probe`. No value of an earlier case of this thread is left
/// in the list of the released values.
fn probe_db(scratch: &Scratch) -> (Runtime, Db) {
    released();
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().expect("runtime");
    let db = runtime.block_on(async {
        let db = Db::connect(&format!("sqlite://{}", scratch.join("machine.sqlite").display()), 2, Config::default()).await.expect("connect");
        let Pool::Sqlite(pool) = db.pool() else { panic!("the test database is SQLite") };
        let mut connection = pool.acquire().await.expect("acquire the fixture connection");
        sqlx::query("CREATE TABLE machine_probe (id INTEGER PRIMARY KEY)").execute(&mut *connection).await.expect("create the table");
        connection.return_to_pool().await;
        db
    });
    (runtime, db)
}

fn insert(runtime: &Runtime, tx: &Tx, id: i64) -> Result<(), Error> {
    runtime.block_on(tx.run("insert", &["machine_probe"], "INSERT INTO machine_probe (id) VALUES (?)", &[Param::I64(id)])).map(|_rows| ())
}

/// The ids of the committed rows, in order.
fn ids(runtime: &Runtime, db: &Db) -> Vec<i64> {
    let Pool::Sqlite(pool) = db.pool() else { panic!("the test database is SQLite") };
    runtime.block_on(sqlx::query_scalar::<_, i64>("SELECT id FROM machine_probe ORDER BY id").fetch_all(pool)).expect("read the rows")
}

fn close(runtime: &Runtime, db: &Db) {
    runtime.block_on(db.close_async());
}

// Requirements: CORE-103. A callback that returns gives the steps Io, Call, Await, Io, Done; the value that settle
// received is the result, the rows are committed, and the handle of the callback has ended.
#[test]
fn a_transaction_machine_commits_and_returns_the_settled_value() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-machine-commit");
    let (runtime, db) = probe_db(&scratch);
    let kept = Rc::new(RefCell::new(None));
    let handle = Rc::clone(&kept);
    let mut machine = db.clone().transaction(
        |tx: Tx| {
            insert(&runtime, &tx, 1).map_err(Failure::Kind)?;
            *handle.borrow_mut() = Some(tx);
            Ok(passed(1))
        },
        once(),
    );
    // The awaitable of the language gives another value than the one that the callback returned.
    let (steps, done) = drive_with(&runtime, &mut machine, |value| {
        drop(value);
        Ok(passed(2))
    });
    assert_eq!(steps, ["Io", "Call", "Await", "Io", "Done"]);
    assert_eq!(done.expect("the transaction commits").into_handle().raw(), 2);
    assert_eq!(released(), [1], "the value that the awaitable replaced is released, and the result is not");
    assert_eq!(ids(&runtime, &db), [1], "the row is committed");
    let tx = kept.borrow_mut().take().expect("the handle of the callback");
    let error = insert(&runtime, &tx, 2).expect_err("a statement after the callback returned");
    assert_eq!(error.kind(), Kind::TransactionEnded, "{error}");
    close(&runtime, &db);
}

// Requirements: CORE-103. An exception of the callback gives the steps Io, Call, Io, Done: the transaction is rolled
// back and the machine ends with the same exception.
#[test]
fn a_transaction_machine_rolls_back_and_returns_the_exception_of_its_callback() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-machine-raised");
    let (runtime, db) = probe_db(&scratch);
    let mut machine = db.clone().transaction(
        |tx: Tx| {
            insert(&runtime, &tx, 1).map_err(Failure::Kind)?;
            Err(Failure::Raised(raised(9)))
        },
        TransactionOptions::default(),
    );
    let (steps, done) = drive(&runtime, &mut machine);
    assert_eq!(steps, ["Io", "Call", "Io", "Done"], "an exception has no kind, so it is not run again");
    assert!(matches!(&done, Err(Failure::Raised(exception)) if raised_id(exception) == Some(9)), "{done:?}");
    assert_eq!(ids(&runtime, &db), [] as [i64; 0], "the row is rolled back");
    close(&runtime, &db);
}

// Requirements: CORE-103. An exception that the awaitable raised, which settle receives, gives the steps Io, Call,
// Await, Io, Done: the transaction is rolled back and the machine ends with that exception.
#[test]
fn a_transaction_machine_rolls_back_after_a_failed_settle() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-machine-settle");
    let (runtime, db) = probe_db(&scratch);
    let mut machine = db.clone().transaction(
        |tx: Tx| {
            insert(&runtime, &tx, 1).map_err(Failure::Kind)?;
            Ok(passed(1))
        },
        TransactionOptions::default(),
    );
    let (steps, done) = drive_with(&runtime, &mut machine, |value| {
        drop(value);
        Err(raised(7))
    });
    assert_eq!(steps, ["Io", "Call", "Await", "Io", "Done"]);
    assert!(matches!(&done, Err(Failure::Raised(exception)) if raised_id(exception) == Some(7)), "{done:?}");
    assert_eq!(released(), [1]);
    assert_eq!(ids(&runtime, &db), [] as [i64; 0], "the row is rolled back");
    close(&runtime, &db);
}

// Requirements: CORE-103, CORE-25. A failure of orm that the callback returned is the result unchanged; when the
// rollback fails too the result is rollback_failed, whose callbackError is the failure of the callback as it was.
#[test]
fn a_transaction_machine_returns_the_failure_of_its_callback_unchanged() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-machine-failure");
    let (runtime, db) = probe_db(&scratch);
    let mut machine = db.clone().transaction(|_tx: Tx| Err(Failure::Kind(Error::config("the callback failed"))), TransactionOptions::default());
    let (steps, done) = drive(&runtime, &mut machine);
    assert_eq!(steps, ["Io", "Call", "Io", "Done"]);
    assert!(matches!(&done, Err(Failure::Kind(error)) if error.to_string() == "config: the callback failed"), "{done:?}");

    db.inner.rollback_fault.store(true, std::sync::atomic::Ordering::Release);
    let mut machine = db.clone().transaction(|_tx: Tx| Err(Failure::Raised(raised(9))), TransactionOptions::default());
    let (steps, done) = drive(&runtime, &mut machine);
    assert_eq!(steps, ["Io", "Call", "Io", "Done"]);
    let Err(Failure::Kind(error)) = done else { panic!("rollback_failed expected: {done:?}") };
    assert_eq!(error.kind(), Kind::RollbackFailed, "{error}");
    assert!(matches!(error.callback_error(), Some(Failure::Raised(exception)) if raised_id(exception) == Some(9)), "{error:?}");
    assert!(matches!(error.rollback_error(), Some(rollback) if rollback.kind() == Kind::Fault), "{error:?}");
    close(&runtime, &db);
}

// Requirements: CORE-26. A panic of the callback rolls the transaction back and is the error internal.
#[test]
fn a_transaction_machine_rolls_back_a_callback_that_panics() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-machine-panic");
    let (runtime, db) = probe_db(&scratch);
    let mut machine = db.clone().transaction(
        |tx: Tx| -> Outcome {
            insert(&runtime, &tx, 1).map_err(Failure::Kind)?;
            panic!("the callback panicked")
        },
        TransactionOptions::default(),
    );
    let (steps, done) = drive(&runtime, &mut machine);
    assert_eq!(steps, ["Io", "Call", "Io", "Done"]);
    assert!(matches!(&done, Err(Failure::Kind(error)) if error.to_string() == "internal: the callback panicked: the callback panicked"), "{done:?}");
    assert_eq!(ids(&runtime, &db), [] as [i64; 0], "the row is rolled back");
    close(&runtime, &db);
}

// Requirements: CORE-104, CORE-24. A failure of the kind deadlock runs steps 1 to 4 again after an Io step that waits,
// and the callback is called once per attempt; retry 0 calls it once.
#[test]
fn a_transaction_machine_calls_its_callback_once_per_attempt() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-machine-retry");
    let (runtime, db) = probe_db(&scratch);
    let mut calls = 0u32;
    let mut machine = db.clone().transaction(
        |tx: Tx| {
            calls += 1;
            insert(&runtime, &tx, i64::from(calls)).map_err(Failure::Kind)?;
            if calls < 3 {
                return Err(Failure::Kind(crate::transaction_conflict("conflict")));
            }
            Ok(passed(3))
        },
        TransactionOptions::default(),
    );
    let (steps, done) = drive(&runtime, &mut machine);
    let failed = ["Io", "Call", "Io", "Io"];
    assert_eq!(steps, [&failed[..], &failed[..], &["Io", "Call", "Await", "Io", "Done"][..]].concat(), "begin, call, rollback and wait twice, then a commit");
    assert_eq!(done.expect("the third attempt commits").into_handle().raw(), 3);
    drop(machine);
    assert_eq!(calls, 3);
    assert_eq!(ids(&runtime, &db), [3], "only the row of the committed attempt is kept");

    let mut calls = 0u32;
    let mut machine = db.clone().transaction(
        |_tx: Tx| {
            calls += 1;
            Err(Failure::Kind(crate::transaction_conflict("always")))
        },
        once(),
    );
    let (steps, done) = drive(&runtime, &mut machine);
    assert_eq!(steps, ["Io", "Call", "Io", "Done"]);
    assert!(matches!(&done, Err(Failure::Kind(error)) if error.kind() == Kind::Deadlock && error.text() == "always"), "{done:?}");
    drop(machine);
    assert_eq!(calls, 1, "retry 0 calls the callback once");
    close(&runtime, &db);
}

// Requirements: CORE-103. A failure of the opening ends the machine after its Io step, and the callback does not run.
#[test]
fn a_transaction_machine_whose_opening_fails_does_not_call_its_callback() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-machine-opening");
    let (runtime, db) = probe_db(&scratch);
    close(&runtime, &db);
    let mut calls = 0u32;
    let mut machine = db.clone().transaction(
        |_tx: Tx| {
            calls += 1;
            Ok(passed(1))
        },
        TransactionOptions::default(),
    );
    let (steps, done) = drive(&runtime, &mut machine);
    assert_eq!(steps, ["Io", "Done"]);
    assert!(matches!(&done, Err(Failure::Kind(error)) if error.kind() == Kind::Closed), "{done:?}");
    drop(machine);
    assert_eq!(calls, 0);
}

// Requirements: CORE-103, CORE-21, CORE-22, CORE-101. A savepoint machine gives the steps of a transaction machine.
// While its callback runs, a statement through a clone of the parent handle is busy; a savepoint that returns is
// released with the transaction, and one whose callback raises is rolled back alone and ends with the same exception.
#[test]
fn a_savepoint_machine_releases_or_rolls_back_inside_its_transaction() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-machine-savepoint");
    let (runtime, db) = probe_db(&scratch);
    let mut machine = db.clone().transaction(
        |tx: Tx| {
            insert(&runtime, &tx, 1).map_err(Failure::Kind)?;
            let parent = tx.clone();
            let mut kept = tx.clone().savepoint(|savepoint: Tx| {
                let busy = insert(&runtime, &parent, 10).expect_err("a statement through a clone of the parent handle");
                assert_eq!(busy.kind(), Kind::Busy, "{busy}");
                insert(&runtime, &savepoint, 2).map_err(Failure::Kind)?;
                Ok(passed(20))
            });
            let (steps, done) = drive(&runtime, &mut kept);
            assert_eq!(steps, ["Io", "Call", "Await", "Io", "Done"]);
            assert_eq!(done.expect("the savepoint is released").into_handle().raw(), 20);
            // The parent handle runs statements again after the savepoint ended.
            insert(&runtime, &tx, 3).map_err(Failure::Kind)?;
            let mut reverted = tx.clone().savepoint(|savepoint: Tx| {
                insert(&runtime, &savepoint, 4).map_err(Failure::Kind)?;
                Err(Failure::Raised(raised(9)))
            });
            let (steps, done) = drive(&runtime, &mut reverted);
            assert_eq!(steps, ["Io", "Call", "Io", "Done"]);
            assert!(matches!(&done, Err(Failure::Raised(exception)) if raised_id(exception) == Some(9)), "{done:?}");
            let mut settled = tx.clone().savepoint(|savepoint: Tx| {
                insert(&runtime, &savepoint, 5).map_err(Failure::Kind)?;
                Ok(passed(21))
            });
            let (steps, done) = drive_with(&runtime, &mut settled, |value| {
                drop(value);
                Err(raised(8))
            });
            assert_eq!(steps, ["Io", "Call", "Await", "Io", "Done"]);
            assert!(matches!(&done, Err(Failure::Raised(exception)) if raised_id(exception) == Some(8)), "{done:?}");
            insert(&runtime, &tx, 6).map_err(Failure::Kind)?;
            Ok(passed(1))
        },
        once(),
    );
    let (steps, done) = drive(&runtime, &mut machine);
    assert_eq!(steps, ["Io", "Call", "Await", "Io", "Done"]);
    assert_eq!(done.expect("the transaction commits").into_handle().raw(), 1);
    drop(machine);
    assert_eq!(released(), [21], "the value of the savepoint whose awaitable raised is released");
    assert_eq!(ids(&runtime, &db), [1, 2, 3, 6], "the rows of the two savepoints that ended with an exception are rolled back");
    close(&runtime, &db);
}

// Requirements: CORE-103, CORE-22, CORE-23. The opening of a savepoint machine fails after its Io step with busy
// while a savepoint callback of the handle runs, and with transaction_ended after the callback of the handle returned;
// its callback does not run.
#[test]
fn a_savepoint_machine_whose_opening_fails_does_not_call_its_callback() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-machine-savepoint-opening");
    let (runtime, db) = probe_db(&scratch);
    let kept = Rc::new(RefCell::new(None));
    let handle = Rc::clone(&kept);
    let mut machine = db.clone().transaction(
        |tx: Tx| {
            let parent = tx.clone();
            let mut outer = tx.clone().savepoint(|_savepoint: Tx| {
                let mut second = parent.clone().savepoint(|_inner: Tx| Ok(passed(31)));
                let (steps, done) = drive(&runtime, &mut second);
                assert_eq!(steps, ["Io", "Done"]);
                assert!(matches!(&done, Err(Failure::Kind(error)) if error.kind() == Kind::Busy), "{done:?}");
                Ok(passed(30))
            });
            let (_steps, done) = drive(&runtime, &mut outer);
            drop(done.expect("the outer savepoint is released"));
            *handle.borrow_mut() = Some(tx);
            Ok(passed(1))
        },
        once(),
    );
    let (_steps, done) = drive(&runtime, &mut machine);
    drop(done.expect("the transaction commits"));
    drop(machine);
    let tx = kept.borrow_mut().take().expect("the handle of the callback");
    let mut late = tx.savepoint(|_savepoint: Tx| Ok(passed(32)));
    let (steps, done) = drive(&runtime, &mut late);
    assert_eq!(steps, ["Io", "Done"]);
    assert!(matches!(&done, Err(Failure::Kind(error)) if error.kind() == Kind::TransactionEnded), "{done:?}");
    assert_eq!(released(), [30, 1], "no callback of a savepoint whose opening failed made a value");
    close(&runtime, &db);
}

// Requirements: CORE-105, CORE-31, CORE-101. The machine of close gives one Io step and ends; every later call of a
// clone of the handle is closed, and a second close succeeds.
#[test]
fn a_close_machine_gives_one_io_step() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-machine-close");
    let (runtime, db) = probe_db(&scratch);
    let mut machine = db.clone().close();
    let (steps, done) = drive(&runtime, &mut machine);
    assert_eq!(steps, ["Io", "Done"]);
    done.expect("the close succeeds");
    let error = runtime.block_on(db.transaction_async(|_tx: Tx| async { Ok(()) }, once())).expect_err("a call after the close");
    assert_eq!(error.kind(), Kind::Closed, "{error}");
    let (steps, done) = drive(&runtime, &mut db.clone().close());
    assert_eq!(steps, ["Io", "Done"]);
    done.expect("a second close succeeds");
}

/// The driver owns an I/O future between two advances and drops it with its machine on cancellation.
#[derive(Clone, Copy, Debug)]
enum Paused {
    Created,
    Opening,
    Opened,
    Call,
    Await,
    Keeping,
    Kept,
}

const PAUSES: [Paused; 7] = [Paused::Created, Paused::Opening, Paused::Opened, Paused::Call, Paused::Await, Paused::Keeping, Paused::Kept];

fn cancel_at<M: Machine>(runtime: &Runtime, mut machine: M, pause: Paused) {
    if matches!(pause, Paused::Created) {
        return;
    }
    let Step::Io(opening) = machine.resume(None) else { panic!("the machine starts with I/O") };
    if matches!(pause, Paused::Opening) {
        drop(machine);
        drop(opening);
        return;
    }
    let opened = runtime.block_on(opening);
    if matches!(pause, Paused::Opened) {
        drop(machine);
        drop(opened);
        return;
    }
    assert!(matches!(machine.resume(Some(opened)), Step::Call));
    if matches!(pause, Paused::Call) {
        return;
    }
    machine.call();
    let Step::Await(value) = machine.resume(None) else { panic!("the callback returns an awaited value") };
    if matches!(pause, Paused::Await) {
        drop(machine);
        drop(value);
        return;
    }
    machine.settle(Ok(value));
    let Step::Io(keeping) = machine.resume(None) else { panic!("the settled machine waits for its end") };
    if matches!(pause, Paused::Keeping) {
        drop(machine);
        drop(keeping);
        return;
    }
    let kept = runtime.block_on(keeping);
    drop(machine);
    drop(kept);
}

fn assert_ended(runtime: &Runtime, tx: &Tx) {
    let error = insert(runtime, tx, 9).expect_err("an aborted machine invalidates retained handles");
    assert_eq!(error.kind(), Kind::TransactionEnded, "{error}");
}

// Requirements: CORE-7. Dropping the machine and its owned I/O future leaves no checked-out connection, including
// when the callback retained its handle; an already-completed commit is not undone.
#[test]
fn dropping_a_transaction_machine_discards_its_connection_at_each_stage() {
    let _case = polyspec_orm_testcase::case!();
    for pause in PAUSES {
        let scratch = Scratch::new("orm-machine-drop-transaction");
        let (runtime, db) = probe_db(&scratch);
        let connections = db.stats().open_connections;
        let kept = Rc::new(RefCell::new(None));
        let handle = Rc::clone(&kept);
        let machine = db.clone().transaction(
            |tx: Tx| {
                insert(&runtime, &tx, 1).map_err(Failure::Kind)?;
                *handle.borrow_mut() = Some(tx);
                Ok(passed(1))
            },
            once(),
        );
        cancel_at(&runtime, machine, pause);
        assert_eq!(db.stats().in_use, 0, "{pause:?}: no connection outlives its cancelled driver");
        let discarded = matches!(pause, Paused::Opened | Paused::Call | Paused::Await | Paused::Keeping);
        assert_eq!(db.stats().open_connections, connections - u32::from(discarded), "{pause:?}: an aborted connection is discarded rather than returned");
        if let Some(tx) = kept.borrow().as_ref() {
            assert_ended(&runtime, tx);
        }
        assert_eq!(ids(&runtime, &db), if matches!(pause, Paused::Kept) { vec![1] } else { vec![] }, "{pause:?}: only a completed commit keeps its row");
        close(&runtime, &db);
    }
}

// Requirements: CORE-7. An active savepoint machine cannot await rollback in Drop; its whole transaction is
// discarded. A machine dropped before its opening is polled owns no savepoint and leaves its parent usable.
#[test]
fn dropping_a_savepoint_machine_invalidates_its_active_parent() {
    let _case = polyspec_orm_testcase::case!();
    for pause in PAUSES {
        for callback_fails in [false, true] {
            let scratch = Scratch::new("orm-machine-drop-savepoint");
            let (runtime, db) = probe_db(&scratch);
            let connections = db.stats().open_connections;
            let mut outer = db.clone().transaction(
                |tx: Tx| {
                    let parent = tx.clone();
                    let kept = Rc::new(RefCell::new(None));
                    let handle = Rc::clone(&kept);
                    let savepoint = tx.clone().savepoint(|child: Tx| {
                        insert(&runtime, &child, 2).map_err(Failure::Kind)?;
                        *handle.borrow_mut() = Some(child);
                        Ok(passed(2))
                    });
                    cancel_at(&runtime, savepoint, pause);
                    if matches!(pause, Paused::Created | Paused::Opening) {
                        insert(&runtime, &parent, 1).map_err(Failure::Kind)?;
                        Ok(passed(1))
                    } else {
                        assert_ended(&runtime, &parent);
                        if let Some(child) = kept.borrow().as_ref() {
                            assert_ended(&runtime, child);
                        }
                        assert_eq!(db.stats().in_use, 0, "{pause:?}: the savepoint discarded its transaction");
                        assert_eq!(db.stats().open_connections, connections - 1, "{pause:?}: the parent connection did not return to the pool");
                        if callback_fails {
                            Err(Failure::Kind(Error::new(Kind::TransactionEnded, "the machine was aborted")))
                        } else {
                            Ok(passed(1))
                        }
                    }
                },
                once(),
            );
            let (_, done) = drive(&runtime, &mut outer);
            if matches!(pause, Paused::Created | Paused::Opening) {
                drop(done.expect("a savepoint that never opened leaves the transaction usable"));
                assert_eq!(ids(&runtime, &db), [1]);
            } else {
                assert!(matches!(&done, Err(Failure::Kind(error)) if error.kind() == Kind::TransactionEnded), "{pause:?}: {done:?}");
                assert_eq!(ids(&runtime, &db), [] as [i64; 0]);
            }
            close(&runtime, &db);
        }
    }
}

// Requirements: CORE-7. An independent future owns its active borrow until it ends or is dropped. Abort invalidates
// handles at once and discards the connection when that borrow leaves; it is never returned to the pool.
#[test]
fn an_aborted_machine_discards_a_borrowed_connection_when_the_borrow_ends() {
    let _case = polyspec_orm_testcase::case!();
    for completes in [false, true] {
        let scratch = Scratch::new("orm-machine-drop-borrowed");
        let (runtime, db) = probe_db(&scratch);
        let connections = db.stats().open_connections;
        let kept = Rc::new(RefCell::new(None));
        let handle = Rc::clone(&kept);
        let mut machine = db.clone().transaction(
            |tx: Tx| {
                *handle.borrow_mut() = Some(tx);
                Ok(passed(1))
            },
            once(),
        );
        let Step::Io(opening) = machine.resume(None) else { panic!("opening") };
        let opened = runtime.block_on(opening);
        assert!(matches!(machine.resume(Some(opened)), Step::Call));
        machine.call();
        let Step::Await(value) = machine.resume(None) else { panic!("awaiting callback") };
        let tx = kept.borrow_mut().take().expect("the callback retained a handle");
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let mut borrowing = Box::pin(async {
            let guard = tx.shared.enter().expect("the transaction is active");
            released.await.expect("the owner releases its borrow");
            drop(guard);
        });
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(std::future::Future::poll(borrowing.as_mut(), &mut context).is_pending());
        drop(machine);
        drop(value);
        assert_ended(&runtime, &tx);
        assert_eq!(db.stats().in_use, 1, "the independent future still owns its borrow");
        if completes {
            release.send(()).expect("the borrowing future still exists");
            runtime.block_on(borrowing);
        } else {
            drop(borrowing);
            drop(release);
        }
        assert_eq!(db.stats().in_use, 0, "an aborted connection was discarded on release");
        assert_eq!(db.stats().open_connections, connections - 1, "the aborted connection did not return to the pool");
        close(&runtime, &db);
    }
}

// Requirements: CORE-102, CORE-105. The binding unwraps the machine's Result even though close declares no errors.
#[test]
fn the_close_machine_contract_declares_its_result() {
    let _case = polyspec_orm_testcase::case!();
    let contract: serde_json::Value = serde_json::from_str(include_str!("../../interface.json")).expect("interface contract");
    let member = contract["units"]
        .as_array()
        .expect("units")
        .iter()
        .flat_map(|unit| unit["members"].as_array().into_iter().flatten())
        .find(|member| member["id"] == "db.close")
        .expect("db.close");
    assert_eq!(member["core"]["result"], true);
}

#[derive(Default)]
struct ReturnGate {
    armed: std::sync::atomic::AtomicBool,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}

// Requirements: CORE-128, INT-91. A failed acquisition sends no statement and cannot invoke a subscriber.
#[test]
fn sqlite_lock_preparation_machine_on_a_closed_pool_emits_no_statement() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-machine-preparation-closed");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    let db = runtime.block_on(Db::connect(&format!("sqlite://{}", scratch.join("closed.sqlite").display()), 1, Config::default())).expect("connect");
    runtime.block_on(db.close_async());
    let events = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&events);
    let subscription = db
        .subscribe(move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
            Err(Error::config("an acquisition failure must not invoke a statement subscriber"))
        })
        .expect("subscribe");
    let result = runtime.block_on(super::ensure_sqlite_lock_table(&db));
    subscription.unsubscribe();
    let error = result.expect_err("a closed pool refuses acquisition");
    assert_eq!(error.kind(), Kind::Closed);
    assert_eq!(error.text(), "database is closed");
    assert_eq!(events.load(Ordering::SeqCst), 0);
}

// Requirements: CORE-128. Preparation cannot report success while its own connection is held at return.
#[test]
fn sqlite_lock_preparation_machine_returns_its_actual_lease_before_completion() {
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-machine-preparation-return");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    let mut db = runtime.block_on(Db::connect(&format!("sqlite://{}", scratch.join("prepare.sqlite").display()), 1, Config::default())).expect("connect");
    runtime.block_on(db.pool().close());
    let gate = Arc::new(ReturnGate::default());
    let on_return = Arc::clone(&gate);
    let pool = runtime
        .block_on(
            sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .after_release(move |_, _| {
                    let gate = Arc::clone(&on_return);
                    Box::pin(async move {
                        if gate.armed.swap(false, Ordering::AcqRel) {
                            gate.entered.notify_one();
                            gate.release.notified().await;
                        }
                        Ok(true)
                    })
                })
                .connect(&format!("sqlite://{}", scratch.join("prepare.sqlite").display())),
        )
        .expect("connect the gated pool");
    Arc::get_mut(&mut db.inner).expect("the fixture owns its Db").pool = Pool::Sqlite(pool);
    gate.armed.store(true, Ordering::Release);
    let preparing_db = db.clone();
    let mut setup = runtime.spawn(async move { super::ensure_sqlite_lock_table(&preparing_db).await });
    let (completed_while_held, result) = runtime.block_on(async {
        let early = tokio::select! {
            _ = gate.entered.notified() => None,
            result = &mut setup => Some(result),
        };
        let completed = early.is_some() || setup.is_finished();
        if early.as_ref().is_some_and(|result| matches!(result, Ok(Ok(())))) {
            gate.entered.notified().await;
        }
        gate.release.notify_one();
        let result = match early {
            Some(result) => result,
            None => setup.await,
        };
        db.close_async().await;
        (completed, result)
    });
    result.expect("the preparation task completes").expect("the lock table is prepared");
    assert!(!completed_while_held, "preparation completed before its actual lease returned");
    assert_eq!(db.stats().in_use, 0, "normal close completed before the assertion");
}

// Requirements: CORE-7. Before terminal I/O acquires the connection, abort prevents COMMIT. After COMMIT and cleanup
// prove the connection clean and admit its return, an independently retained return future may complete after Drop.
#[test]
fn an_admitted_clean_return_can_complete_after_its_machine_is_dropped() {
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    let _case = polyspec_orm_testcase::case!();
    for (admitted, completes) in [(false, false), (true, true), (true, false)] {
        let scratch = Scratch::new("orm-machine-drop-clean-return");
        let (runtime, mut db) = probe_db(&scratch);
        runtime.block_on(db.pool().close());
        let gate = Arc::new(ReturnGate::default());
        let on_return = Arc::clone(&gate);
        let pool = runtime
            .block_on(
                sqlx::sqlite::SqlitePoolOptions::new()
                    .max_connections(1)
                    .after_release(move |_, _| {
                        let gate = Arc::clone(&on_return);
                        Box::pin(async move {
                            if gate.armed.swap(false, Ordering::AcqRel) {
                                gate.entered.notify_one();
                                gate.release.notified().await;
                            }
                            Ok(true)
                        })
                    })
                    .connect(&format!("sqlite://{}", scratch.join("machine.sqlite").display())),
            )
            .expect("the gated pool opens the fixture database");
        Arc::get_mut(&mut db.inner).expect("the fixture owns its Db").pool = Pool::Sqlite(pool);
        let kept = Rc::new(RefCell::new(None));
        let handle = Rc::clone(&kept);
        let mut machine = db.clone().transaction(
            |tx: Tx| {
                insert(&runtime, &tx, 1).map_err(Failure::Kind)?;
                *handle.borrow_mut() = Some(tx);
                Ok(passed(1))
            },
            once(),
        );
        let Step::Io(opening) = machine.resume(None) else { panic!("opening") };
        let opened = runtime.block_on(opening);
        assert!(matches!(machine.resume(Some(opened)), Step::Call));
        machine.call();
        let Step::Await(value) = machine.resume(None) else { panic!("awaiting callback") };
        machine.settle(Ok(value));
        let Step::Io(ending) = machine.resume(None) else { panic!("ending") };
        if admitted {
            gate.armed.store(true, Ordering::Release);
            let ending = runtime.spawn(ending);
            runtime.block_on(gate.entered.notified());
            drop(machine);
            assert_ended(&runtime, kept.borrow().as_ref().expect("the retained transaction"));
            assert_eq!(db.stats().in_use, 1, "the admitted return future owns the proven-clean connection");
            if completes {
                gate.release.notify_one();
                drop(runtime.block_on(ending).expect("the independent terminal future completes"));
            } else {
                ending.abort();
                assert!(matches!(runtime.block_on(ending), Err(error) if error.is_cancelled()), "the driver dropped its owned terminal future");
            }
            assert_ended(&runtime, kept.borrow().as_ref().expect("the retained transaction"));
        } else {
            drop(machine);
            drop(runtime.block_on(ending));
        }
        assert_eq!(db.stats().in_use, 0);
        assert_eq!(db.stats().open_connections, u32::from(admitted && completes), "only a completed previously admitted clean return may keep its connection");
        assert_eq!(ids(&runtime, &db), if admitted { vec![1] } else { vec![] }, "Drop does not undo an already-completed COMMIT");
        close(&runtime, &db);
    }
}

// Requirements: CORE-7. An independently retained opening cannot acquire a savepoint after its owner was dropped.
#[test]
fn a_retained_savepoint_opening_cannot_start_after_its_owner_is_dropped() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-machine-retained-opening");
    let (runtime, db) = probe_db(&scratch);
    let mut outer = db.clone().transaction(
        |tx: Tx| {
            let mut child = tx.clone().savepoint(|_: Tx| panic!("a cancelled opening cannot call its callback"));
            let Step::Io(opening) = child.resume(None) else { panic!("opening") };
            drop(child);
            drop(runtime.block_on(opening));
            insert(&runtime, &tx, 1).map_err(Failure::Kind)?;
            Ok(passed(1))
        },
        once(),
    );
    let (_, done) = drive(&runtime, &mut outer);
    drop(done.expect("the parent remains usable"));
    assert_eq!(ids(&runtime, &db), [1]);
    close(&runtime, &db);
}

// Requirements: CORE-7. A rollback Io is owned by the driver unless retained separately; only an already completed,
// clean rollback can return its connection. Retained handles are invalid in every case.
#[test]
fn cancellation_at_rollback_preserves_terminal_ownership() {
    let _case = polyspec_orm_testcase::case!();
    for terminal in 0..3 {
        let scratch = Scratch::new("orm-machine-drop-rollback");
        let (runtime, db) = probe_db(&scratch);
        let connections = db.stats().open_connections;
        let kept = Rc::new(RefCell::new(None));
        let handle = Rc::clone(&kept);
        let mut machine = db.clone().transaction(
            |tx: Tx| {
                insert(&runtime, &tx, 1).map_err(Failure::Kind)?;
                *handle.borrow_mut() = Some(tx);
                Err(Failure::Raised(raised(1)))
            },
            once(),
        );
        let Step::Io(opening) = machine.resume(None) else { panic!("opening") };
        let opened = runtime.block_on(opening);
        assert!(matches!(machine.resume(Some(opened)), Step::Call));
        machine.call();
        let Step::Io(rollback) = machine.resume(None) else { panic!("rollback") };
        match terminal {
            0 => {
                drop(machine);
                drop(rollback);
            }
            1 => {
                drop(machine);
                drop(runtime.block_on(rollback));
            }
            _ => {
                drop(runtime.block_on(rollback));
                drop(machine);
            }
        }
        assert_ended(&runtime, kept.borrow().as_ref().expect("the retained transaction"));
        assert_eq!(db.stats().in_use, 0);
        assert_eq!(db.stats().open_connections, connections - u32::from(terminal != 2));
        assert_eq!(ids(&runtime, &db), [] as [i64; 0]);
        close(&runtime, &db);
    }
}

/// A test-owned line-JSON peer. It acknowledges setup statements and gates the actual terminal request before its ACK.
/// The ACK proves transport ownership only: this peer models no storage or transaction outcome (CORE-7, PRT-64).
struct TerminalPeer {
    address: std::net::SocketAddr,
    accepted: Option<std::sync::mpsc::Receiver<std::net::TcpStream>>,
    terminal: std::sync::mpsc::Receiver<String>,
    reply: Option<std::sync::mpsc::Sender<bool>>,
    thread: Option<std::thread::JoinHandle<Result<(), String>>>,
}

impl TerminalPeer {
    fn new() -> Self {
        use std::io::{BufRead as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("the peer owns its listener");
        let address = listener.local_addr().expect("the system assigns the peer port");
        let (accepted, connection) = std::sync::mpsc::channel();
        let (observed, terminal) = std::sync::mpsc::channel();
        let (reply, replies) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || -> Result<(), String> {
            let (socket, _) = listener.accept().map_err(|error| error.to_string())?;
            drop(listener);
            accepted.send(socket.try_clone().map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
            let mut writer = socket.try_clone().map_err(|error| error.to_string())?;
            let mut reader = std::io::BufReader::new(socket);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).map_err(|error| error.to_string())? == 0 {
                    return Err("the connection ended before its terminal request".into());
                }
                let request: serde_json::Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
                let terminal = request["sql"].as_str().filter(|sql| matches!(*sql, "COMMIT" | "ROLLBACK"));
                if let Some(sql) = terminal {
                    if request["op"] != "statement" || request["params"] != serde_json::json!([]) {
                        return Err(format!("malformed terminal statement: {line}"));
                    }
                    observed.send(sql.to_owned()).map_err(|error| error.to_string())?;
                    if replies.recv().unwrap_or(false) {
                        writeln!(writer, "{{\"ok\":true}}").map_err(|error| error.to_string())?;
                    }
                    line.clear();
                    return match reader.read_line(&mut line) {
                        Ok(0) => Ok(()),
                        Ok(_) => Err(format!("an aborted connection sent another request: {line}")),
                        Err(error) => Err(error.to_string()),
                    };
                }
                let setup = match request["op"].as_str() {
                    Some("connect") => request["corpus"] == "machine" && request["token"] == "0123456789abcdef0123456789abcdef",
                    Some("statement") => {
                        matches!(
                            request["sql"].as_str(),
                            Some("BEGIN IMMEDIATE" | r#"CREATE TABLE IF NOT EXISTS "orm__row_lock" ("id" INTEGER PRIMARY KEY CHECK ("id" = 1))"#)
                        ) && request["params"] == serde_json::json!([])
                    }
                    _ => false,
                };
                if !setup {
                    return Err(format!("unexpected setup request: {line}"));
                }
                writeln!(writer, "{{\"ok\":true}}").map_err(|error| error.to_string())?;
            }
        });
        Self { address, accepted: Some(connection), terminal, reply: Some(reply), thread: Some(thread) }
    }

    fn dsn(&self) -> String {
        format!("markdown://{}/machine?token=0123456789abcdef0123456789abcdef", self.address)
    }

    fn finish(&mut self) {
        self.thread.take().expect("the peer is owned").join().expect("the peer thread did not panic").expect("the peer observed EOF");
    }
}

impl Drop for TerminalPeer {
    fn drop(&mut self) {
        let Some(thread) = self.thread.take() else { return };
        // Unblocks a peer waiting to ACK a terminal request.
        drop(self.reply.take());
        // Wakes accept on preparation failure. If the real connection was already accepted, the listener is closed.
        if let Ok(wakeup) = std::net::TcpStream::connect(self.address) {
            let _ = wakeup.shutdown(std::net::Shutdown::Both);
        }
        if let Some(accepted) = self.accepted.take() {
            if let Ok(socket) = accepted.recv() {
                let _ = socket.shutdown(std::net::Shutdown::Both);
            }
        }
        let _ = thread.join();
    }
}

// Requirements: CORE-7, PRT-64. A real terminal request is in flight before its ACK. Dropping owned I/O closes that
// socket; retained I/O may complete but its aborted transaction cannot reuse the socket. No storage outcome is claimed.
#[test]
fn cancellation_of_terminal_wire_io_preserves_its_independent_ownership() {
    let _case = polyspec_orm_testcase::case!();
    for commit in [false, true] {
        for completes in [false, true] {
            let mut peer = TerminalPeer::new();
            let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().expect("runtime");
            let db = runtime.block_on(Db::connect(&peer.dsn(), 1, Config::default())).expect("the peer accepts the connection");
            let kept = Rc::new(RefCell::new(None));
            let handle = Rc::clone(&kept);
            let mut machine = db.clone().transaction(
                |tx: Tx| {
                    *handle.borrow_mut() = Some(tx);
                    if commit {
                        Ok(passed(1))
                    } else {
                        Err(Failure::Raised(raised(1)))
                    }
                },
                once(),
            );
            let Step::Io(opening) = machine.resume(None) else { panic!("opening") };
            let opened = runtime.block_on(opening);
            assert!(matches!(machine.resume(Some(opened)), Step::Call));
            machine.call();
            let step = machine.resume(None);
            let terminal = match step {
                Step::Await(value) => {
                    machine.settle(Ok(value));
                    machine.resume(None)
                }
                other => other,
            };
            let Step::Io(terminal) = terminal else { panic!("the terminal I/O owns the connection") };
            let terminal = runtime.spawn(terminal);
            assert_eq!(peer.terminal.recv().expect("the peer received the terminal request"), if commit { "COMMIT" } else { "ROLLBACK" });
            drop(machine);
            assert_ended(&runtime, kept.borrow().as_ref().expect("the retained handle"));
            assert_eq!(db.stats().in_use, 1, "the independently polled future owns the terminal socket until it ends");
            if completes {
                peer.reply.as_ref().expect("the peer is gated").send(true).expect("the terminal reply is admitted");
                drop(runtime.block_on(terminal).expect("the retained future completes"));
            } else {
                terminal.abort();
                assert!(matches!(runtime.block_on(terminal), Err(error) if error.is_cancelled()), "the driver dropped its terminal I/O");
                peer.reply.as_ref().expect("the peer is gated").send(false).expect("the peer checks EOF without an ACK");
            }
            assert_ended(&runtime, kept.borrow().as_ref().expect("the retained handle"));
            assert_eq!(db.stats().in_use, 0);
            assert_eq!(db.stats().open_connections, 0, "a terminal result after abort never admits return to the pool");
            peer.finish();
            close(&runtime, &db);
        }
    }
}
