//! INT-53 `backend_waiting_for_lock` with a waiter on PostgreSQL; the recipe utils holds the rest of the utilities of the Rust client,
//! PostgreSQL. The model is the clock fixture (contracts/fixtures/clock.dbs). Each case runs in a case database of its own
//! (polyspec-orm-case-database). The test fails when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.

use crate::clock_test_support;
use clock_test_support::{connected, ClockEvent, OrPanic, CLOCK_SCHEMA};

use std::time::Duration;

use polyspec_orm::{Db, Model, Param, TransactionOptions, Tx, Val};

fn once() -> TransactionOptions {
    TransactionOptions { retry: Some(0), ..Default::default() }
}
use polyspec_orm_case_database::CaseDatabase;

const CASE_DEADLINE: Duration = Duration::from_secs(60);

/// Inserts one clock event with label in the transaction of `tx` and returns its identity key.
async fn insert_event(tx: &Tx, label: &str) -> i64 {
    let mut row = connected::<ClockEvent>(tx);
    row.core_mut().set("label", Param::from(label));
    let created = polyspec_orm::model::create(&mut row).await.or_panic(|e| format!("create {label}: {e}"));
    match created.value("seq") {
        Some(Val::I64(seq)) => seq,
        other => panic!("the identity of {label}: {other:?}"),
    }
}

/// PostgreSQL: a second backend that waits for a row lock is reported. The transaction holds the row, and a task on a second
/// connection, started after the row is held, updates the same row and blocks until the transaction ends. The check is bounded
/// to ten seconds.
async fn postgres_waiter(dsn: &str, db: &Db) {
    let utils = db.utils();
    let seq = db.transaction(|tx: Tx| async move { Ok(insert_event(&tx, "held").await) }, once()).await.or_panic(|e| format!("postgres: {e}"));
    let utils = &utils;
    let (waiting, waiter) = db
        .transaction(
            |tx: Tx| async move {
                let mut row = connected::<ClockEvent>(&tx);
                row.core_mut().set("seq", Param::from(seq));
                row.core_mut().set("label", Param::from("parent"));
                polyspec_orm::model::update(&mut row, false).await?;
                let owned = dsn.to_owned();
                let waiter = tokio::spawn(async move {
                    let other = Db::connect_schema(&owned, &CLOCK_SCHEMA, 1, polyspec_orm::Config::default()).await?;
                    let mut row = connected::<ClockEvent>(&other);
                    row.core_mut().set("seq", Param::from(seq));
                    row.core_mut().set("label", Param::from("waiter"));
                    let result = polyspec_orm::model::update(&mut row, false).await;
                    other.close().await;
                    result
                });
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                let mut waiting = false;
                while !waiting && std::time::Instant::now() < deadline {
                    waiting = utils.backend_waiting_for_lock().await?;
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Ok((waiting, waiter))
            },
            once(),
        )
        .await
        .or_panic(|e| format!("postgres: {e}"));
    assert!(waiting, "postgres: the waiting backend is reported while the transaction holds the row");
    waiter.await.expect("the waiter ends").or_panic(|e| format!("postgres: the waiting update: {e}"));
}

async fn bounded(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = Db::connect_schema(database.dsn(), &CLOCK_SCHEMA, 4, polyspec_orm::Config::default()).await.or_panic(|e| format!("{driver}: {e}"));
    db.utils().schema().install(&CLOCK_SCHEMA).await.or_panic(|e| format!("{driver}: install: {e}"));
    postgres_waiter(database.dsn(), &db).await;
    db.close().await;
    database.drop().await;
}

#[tokio::main(flavor = "current_thread")]
// Requirements: INT-53.
async fn was_inserted_postgres() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(CASE_DEADLINE, bounded("postgres")).await.expect("postgres: the case ends");
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("was_inserted": was_inserted_postgres)
}
