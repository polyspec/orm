//! The execution flow of a Rust transaction, on a SQLite file: a transaction is active in the tokio task that opened it,
//! so a task spawned inside the callback has no active transaction and an unconnected model there returns CONFIG, and two
//! statements of the callback that overlap on the transaction connection return CONFIG. The test of DSL-121, INT-47 and DSL-122
//! (docs/spec/dsl.md "Transactions").

use polyspec_orm::{Db, Model};

use crate::sqlite_case;
use sqlite_case::{Database, SCHEMA};

async fn database(name: &str) -> Database {
    sqlite_case::database("transaction-flow", name).await
}

use crate::service_model;
use service_model::service;

#[tokio::main(flavor = "current_thread")]
// Requirements: PLN-18.
async fn spawned_task_has_no_transaction() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let file = database("spawned").await;
    let db = Db::connect_schema(&file.dsn, &SCHEMA, 1, polyspec_orm::Config::default()).await.unwrap();
    let (inside, spawned) = db
        .transaction(async || {
            let inside = polyspec_orm::model::get_count(service(None).core()).await?;
            let spawned = tokio::spawn(async { polyspec_orm::model::get_count(service(None).core()).await }).await.expect("the spawned task ends");
            Ok((inside, spawned.err().map(|e| e.code().to_owned())))
        })
        .retry(0)
        .await
        .unwrap();
    db.close().await;
    assert_eq!(inside, 0, "the callback reads in its transaction");
    assert_eq!(spawned.as_deref(), Some(polyspec_orm::codes::CONFIG), "a task spawned in the callback has no active transaction");
}

#[tokio::main(flavor = "current_thread")]
// Requirements: PLN-18.
async fn overlapping_statements_on_the_transaction_connection_return_config() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let file = database("overlap").await;
    let db = Db::connect_schema(&file.dsn, &SCHEMA, 1, polyspec_orm::Config::default()).await.unwrap();
    let codes = db
        .transaction(async || {
            let (first, second) = (service(None), service(None));
            // The first statement is held inside the transaction connection, and the second is attempted only after the
            // first has reached the hold, so the overlap happens on every schedule and the second is refused.
            let hold = polyspec_orm::testing::hold_next_statement(&db);
            let held = polyspec_orm::model::get_count(first.core());
            let attempt = async {
                hold.reached().await;
                let second = polyspec_orm::model::get_count(second.core()).await;
                hold.release();
                second
            };
            let (a, b) = tokio::join!(held, attempt);
            Ok([a, b].map(|r| r.err().map(|e| e.code().to_owned())))
        })
        .retry(0)
        .await
        .unwrap();
    db.close().await;
    assert_eq!(codes[0], None, "the held statement of the transaction gave {codes:?}");
    assert_eq!(codes[1].as_deref(), Some(polyspec_orm::codes::CONFIG), "the overlapping statement of the transaction gave {codes:?}, not CONFIG");
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("transaction_flow": spawned_task_has_no_transaction, overlapping_statements_on_the_transaction_connection_return_config)
}
