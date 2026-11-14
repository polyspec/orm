// The cancellation that a handle carries (CORE-45, CORE-46): a statement, a BEGIN and a SAVEPOINT of a handle whose
// cancellation has fired are canceled and are not sent, and the end of a transaction is still sent. The cases run on
// a SQLite file of their own.

use crate::test_support::Scratch;
use crate::{Config, Connection, Db, Kind, Query, Schema, TransactionOptions};
use binding_core::cancel_pair;
use std::sync::{Arc, Mutex};

const CLOCK: &str = include_str!("../../../../contracts/fixtures/clock.dbs");
const CLOCK_HASH: &str = "sha256:fab61fb83cfec00c4d7a4d257b610b87c6fdccd49e02a85848a41ba263bc1ffb";
const CANCELED: &str = "canceled: the cancellation of the handle has fired";

/// The kinds of the statements that a database sent, in order, without the utility statements of its connection.
#[derive(Clone, Default)]
struct Sent(Arc<Mutex<Vec<String>>>);

impl Sent {
    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().expect("the list of sent statements"))
    }
}

/// A SQLite database with the table of clock.dbs, and the list of the statements it sends from now on.
async fn clock_db(scratch: &Scratch) -> (Db, Schema, Sent) {
    let schema = Schema::load(CLOCK, "", CLOCK_HASH).expect("clock.dbs loads");
    let db = Db::connect(&format!("sqlite://{}", scratch.join("clock.sqlite").display()), 1, Config::default()).await.expect("connect");
    db.utils().schema().install(&schema).await.expect("install");
    let sent = Sent::default();
    let list = sent.clone();
    let subscription = db
        .subscribe(move |event: &crate::StatementEvent<'_>| {
            if event.kind != crate::events::KIND_UTILITY {
                list.0.lock().expect("the list of sent statements").push(event.kind.to_owned());
            }
            Ok(())
        })
        .expect("subscribe");
    // The subscription lasts as long as the database of the case.
    std::mem::forget(subscription);
    (db, schema, sent)
}

fn count_of(schema: &Schema, connection: Connection) -> Query {
    let mut query = Query::new(schema, "clock_event").expect("query");
    query.connect(connection);
    query
}

// Requirements: CORE-45, CORE-46. A statement of the handle is sent until its cancellation fires and is canceled after
// it; the handle that with_cancel was called on is not changed.
#[tokio::test]
async fn a_statement_after_the_cancellation_is_canceled_and_not_sent() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-cancel-statement");
    let (db, schema, sent) = clock_db(&scratch).await;
    let (trigger, cancel) = cancel_pair();
    let handle = db.with_cancel(cancel);
    assert_eq!(count_of(&schema, Connection::from(&handle)).get_count().await.expect("before the cancellation"), 0);
    assert_eq!(sent.take(), ["select"]);
    trigger.cancel();
    let error = count_of(&schema, Connection::from(&handle)).get_count().await.expect_err("after the cancellation");
    assert_eq!(error.kind(), Kind::Canceled, "{error}");
    assert_eq!(error.to_string(), CANCELED);
    assert_eq!(sent.take(), [] as [&str; 0], "a canceled statement is not sent");
    assert_eq!(count_of(&schema, Connection::from(&db)).get_count().await.expect("the handle without the cancellation"), 0);
    assert_eq!(sent.take(), ["select"]);
    db.close().await;
}

// Requirements: CORE-46. The install of the schema tools of the handle starts with a BEGIN of the handle, which is
// canceled.
#[tokio::test]
async fn a_schema_install_after_the_cancellation_is_canceled_and_not_sent() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-cancel-schema");
    let (db, schema, sent) = clock_db(&scratch).await;
    let (trigger, cancel) = cancel_pair();
    let handle = db.with_cancel(cancel);
    trigger.cancel();
    let error = handle.utils().schema().install(&schema).await.expect_err("an install after the cancellation");
    assert_eq!(error.to_string(), CANCELED);
    assert_eq!(sent.take(), [] as [&str; 0], "a canceled install sends nothing");
    db.close().await;
}

// Requirements: CORE-46. The BEGIN of a handle whose cancellation has fired is canceled: nothing is sent and the
// callback does not run.
#[tokio::test]
async fn a_begin_after_the_cancellation_is_canceled_and_not_sent() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-cancel-begin");
    let (db, _schema, sent) = clock_db(&scratch).await;
    let (trigger, cancel) = cancel_pair();
    let handle = db.with_cancel(cancel);
    trigger.cancel();
    let ran = Arc::new(Mutex::new(false));
    let error = handle
        .transaction(
            |_tx| {
                let ran = Arc::clone(&ran);
                async move {
                    *ran.lock().expect("the mark of the callback") = true;
                    Ok(())
                }
            },
            TransactionOptions::default(),
        )
        .await
        .expect_err("a transaction after the cancellation");
    assert_eq!(error.to_string(), CANCELED);
    assert!(!*ran.lock().expect("the mark of the callback"), "the callback of a canceled BEGIN does not run");
    assert_eq!(sent.take(), [] as [&str; 0], "a canceled BEGIN is not sent");
    db.close().await;
}

// Requirements: CORE-45, CORE-46. The Tx of a transaction carries the cancellation of the handle that started it: a
// statement of the Tx after the cancellation is canceled, and the ROLLBACK of its transaction is still sent.
#[tokio::test]
async fn a_canceled_transaction_still_rolls_back() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-cancel-rollback");
    let (db, schema, sent) = clock_db(&scratch).await;
    let (trigger, cancel) = cancel_pair();
    let handle = db.with_cancel(cancel);
    let error = handle
        .transaction(
            |tx| {
                let (schema, trigger) = (&schema, &trigger);
                async move {
                    let query = count_of(schema, Connection::from(&tx));
                    query.get_count().await?;
                    trigger.cancel();
                    query.get_count().await
                }
            },
            TransactionOptions::default(),
        )
        .await
        .expect_err("a statement after the cancellation");
    assert_eq!(error.to_string(), CANCELED);
    assert_eq!(sent.take(), ["begin", "select", "rollback"], "the second statement is not sent and the ROLLBACK is");
    db.close().await;
}

// Requirements: CORE-46. A callback that returns a value after the cancellation fired commits: the COMMIT is sent
// whatever the cancellation.
#[tokio::test]
async fn a_canceled_transaction_still_commits() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-cancel-commit");
    let (db, _schema, sent) = clock_db(&scratch).await;
    let (trigger, cancel) = cancel_pair();
    let handle = db.with_cancel(cancel);
    handle
        .transaction(
            |_tx| {
                let trigger = &trigger;
                async move {
                    trigger.cancel();
                    Ok(())
                }
            },
            TransactionOptions::default(),
        )
        .await
        .expect("a callback that returns a value");
    assert_eq!(sent.take(), ["begin", "commit"]);
    db.close().await;
}

// Requirements: CORE-46. A SAVEPOINT after the cancellation is canceled and not sent; a cancellation that fires inside
// a savepoint still sends ROLLBACK TO SAVEPOINT and RELEASE SAVEPOINT, and a savepoint whose callback returns a value
// still sends RELEASE SAVEPOINT.
#[tokio::test]
async fn a_canceled_savepoint_still_ends() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-cancel-savepoint");
    let (db, schema, sent) = clock_db(&scratch).await;
    for (fails, ends) in [(true, &["begin", "savepoint", "rollback_to", "release", "commit"][..]), (false, &["begin", "savepoint", "release", "commit"][..])] {
        let (trigger, cancel) = cancel_pair();
        let handle = db.with_cancel(cancel);
        handle
            .transaction(
                |tx| {
                    let (schema, trigger) = (&schema, &trigger);
                    async move {
                        let inside = tx
                            .savepoint(|inner| async move {
                                trigger.cancel();
                                if fails {
                                    count_of(schema, Connection::from(&inner)).get_count().await.map(drop)
                                } else {
                                    Ok(())
                                }
                            })
                            .await;
                        assert_eq!(inside.is_err(), fails);
                        if let Err(error) = inside {
                            assert_eq!(error.to_string(), CANCELED);
                        }
                        let error = tx.savepoint(|_inner| async { Ok(()) }).await.expect_err("a savepoint after the cancellation");
                        assert_eq!(error.to_string(), CANCELED);
                        Ok(())
                    }
                },
                TransactionOptions::default(),
            )
            .await
            .expect("the transaction");
        assert_eq!(sent.take(), ends, "fails {fails}");
    }
    db.close().await;
}
