//! The execution flow of a Rust transaction, on a SQLite file: a transaction is active in the tokio task that opened it,
//! so a task spawned inside the callback has no active transaction and an unconnected model there returns CONFIG, and two
//! statements of the callback that overlap on the transaction connection return CONFIG. The test of DSL-121 and DSL-122
//! (docs/spec/dsl.md "Transactions").

use polyspec_orm::{Db, Model};

#[path = "common/sqlite_case.rs"]
mod sqlite_case;
use sqlite_case::{Database, SCHEMA};

async fn database(name: &str) -> Database {
    sqlite_case::database("transaction-flow", name).await
}

#[macro_use]
#[path = "common/typed_model.rs"]
mod typed_model;

#[path = "common/service_model.rs"]
mod service_model;
use service_model::service;

#[tokio::test]
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

#[tokio::test]
async fn overlapping_statements_on_the_transaction_connection_return_config() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let file = database("overlap").await;
    let db = Db::connect_schema(&file.dsn, &SCHEMA, 1, polyspec_orm::Config::default()).await.unwrap();
    let codes = db
        .transaction(async || {
            let (first, second) = (service(None), service(None));
            let (a, b) = tokio::join!(polyspec_orm::model::get_count(first.core()), polyspec_orm::model::get_count(second.core()));
            Ok([a, b].map(|r| r.err().map(|e| e.code().to_owned())))
        })
        .retry(0)
        .await
        .unwrap();
    db.close().await;
    assert!(
        codes.iter().any(|c| c.as_deref() == Some(polyspec_orm::codes::CONFIG)),
        "two overlapping statements of one transaction gave {codes:?}, without CONFIG"
    );
}
