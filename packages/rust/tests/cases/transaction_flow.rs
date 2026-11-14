//! The transaction handle of a Rust transaction, on a SQLite file (docs/spec/core.md CORE-20, CORE-22, CORE-23): a model runs
//! in a transaction only through `connect(&tx)`, so an unconnected model is `config` in the callback and in a task it spawns;
//! two statements that overlap on the transaction are `busy`; a statement through the parent handle while a savepoint
//! callback runs is `busy`; and a handle used after its callback returned is `transaction_ended`.

use polyspec_orm::{Db, Kind, Model, TransactionOptions, Tx};

use crate::sqlite_case;
use sqlite_case::{Database, SCHEMA};

async fn database(name: &str) -> Database {
    sqlite_case::database("transaction-flow", name).await
}

use crate::service_model;
use service_model::service;

fn once() -> TransactionOptions {
    TransactionOptions { retry: Some(0), ..Default::default() }
}

fn kind_of<T>(result: polyspec_orm::Result<T>) -> Option<Kind> {
    result.err().map(|error| error.kind())
}

#[tokio::main(flavor = "current_thread")]
// Requirements: CORE-20.
async fn a_model_runs_in_the_transaction_only_through_its_handle() {
    let _case = polyspec_orm_testcase::case!();
    let file = database("handle").await;
    let db = Db::connect_schema(&file.dsn, &SCHEMA, 1, polyspec_orm::Config::default()).await.unwrap();
    let (inside, unconnected, spawned) = db
        .transaction(
            |tx: Tx| async move {
                let inside = polyspec_orm::model::get_count(service(Some((&tx).into())).core()).await?;
                let unconnected = kind_of(polyspec_orm::model::get_count(service(None).core()).await);
                let spawned = tokio::spawn(async { polyspec_orm::model::get_count(service(None).core()).await }).await.expect("the spawned task ends");
                Ok((inside, unconnected, kind_of(spawned)))
            },
            once(),
        )
        .await
        .unwrap();
    db.close().await;
    assert_eq!(inside, 0, "the callback reads in its transaction through the handle");
    assert_eq!(unconnected, Some(Kind::Config), "an unconnected model has no transaction");
    assert_eq!(spawned, Some(Kind::Config), "a task spawned in the callback has no transaction either");
}

#[tokio::main(flavor = "current_thread")]
// Requirements: CORE-22.
async fn overlapping_statements_on_the_transaction_are_busy() {
    let _case = polyspec_orm_testcase::case!();
    let file = database("overlap").await;
    let db = Db::connect_schema(&file.dsn, &SCHEMA, 1, polyspec_orm::Config::default()).await.unwrap();
    let kinds = db
        .transaction(
            |tx: Tx| {
                let db = db.clone();
                async move {
                    let (first, second) = (service(Some((&tx).into())), service(Some((&tx).into())));
                    // The first statement is held inside the transaction connection, and the second is attempted only after
                    // the first has reached the hold, so the overlap happens on every schedule and the second is refused.
                    let hold = polyspec_orm::testing::hold_next_statement(&db);
                    let held = polyspec_orm::model::get_count(first.core());
                    let attempt = async {
                        hold.reached().await;
                        let second = polyspec_orm::model::get_count(second.core()).await;
                        hold.release();
                        second
                    };
                    let (a, b) = tokio::join!(held, attempt);
                    Ok([kind_of(a), kind_of(b)])
                }
            },
            once(),
        )
        .await
        .unwrap();
    db.close().await;
    assert_eq!(kinds, [None, Some(Kind::Busy)], "the held statement and the overlapping one");
}

#[tokio::main(flavor = "current_thread")]
// Requirements: CORE-21, CORE-22.
async fn the_parent_handle_is_busy_while_a_savepoint_runs() {
    let _case = polyspec_orm_testcase::case!();
    let file = database("savepoint-busy").await;
    let db = Db::connect_schema(&file.dsn, &SCHEMA, 1, polyspec_orm::Config::default()).await.unwrap();
    let kinds = db
        .transaction(
            |tx: Tx| async move {
                let parent = tx.clone();
                let inner = tx
                    .savepoint(|savepoint: Tx| async move {
                        let parent = kind_of(polyspec_orm::model::get_count(service(Some((&parent).into())).core()).await);
                        let nested = kind_of(parent_savepoint(&parent_handle_of(&savepoint)).await);
                        let child = kind_of(polyspec_orm::model::get_count(service(Some((&savepoint).into())).core()).await);
                        Ok((parent, nested, child))
                    })
                    .await?;
                let after = kind_of(polyspec_orm::model::get_count(service(Some((&tx).into())).core()).await);
                Ok((inner, after))
            },
            once(),
        )
        .await
        .unwrap();
    db.close().await;
    assert_eq!(kinds, ((Some(Kind::Busy), None, None), None), "parent, nested savepoint and child during the savepoint; parent after it");
}

fn parent_handle_of(savepoint: &Tx) -> Tx {
    savepoint.clone()
}

async fn parent_savepoint(handle: &Tx) -> polyspec_orm::Result<()> {
    handle.savepoint(|_inner: Tx| async { Ok(()) }).await
}

#[tokio::main(flavor = "current_thread")]
// Requirements: CORE-23.
async fn a_handle_after_its_callback_is_transaction_ended() {
    let _case = polyspec_orm_testcase::case!();
    let file = database("ended").await;
    let db = Db::connect_schema(&file.dsn, &SCHEMA, 1, polyspec_orm::Config::default()).await.unwrap();
    let kept = db.transaction(|tx: Tx| async move { Ok(tx) }, once()).await.unwrap();
    let model = kind_of(polyspec_orm::model::get_count(service(Some((&kept).into())).core()).await);
    let run = kind_of(kept.run("utility", &[], "SELECT 1", &[]).await);
    let savepoint = kind_of(kept.savepoint(|_inner: Tx| async { Ok(()) }).await);
    db.close().await;
    assert_eq!((model, run, savepoint), (Some(Kind::TransactionEnded), Some(Kind::TransactionEnded), Some(Kind::TransactionEnded)));
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("transaction_flow": a_model_runs_in_the_transaction_only_through_its_handle, overlapping_statements_on_the_transaction_are_busy, the_parent_handle_is_busy_while_a_savepoint_runs, a_handle_after_its_callback_is_transaction_ended)
}
