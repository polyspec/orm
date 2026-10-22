//! LISTEN and NOTIFY on PostgreSQL (DIA-192 to DIA-196, PRT-74). A notification sent inside a transaction is delivered
//! with its commit and dropped by a rollback; one sent outside a transaction is delivered at once; unlisten stops a
//! channel; a receive whose deadline expires fails with CANCELED and closes the subscription; and MySQL and SQLite refuse
//! notify and listen with CAPABILITY_UNSUPPORTED. Each case runs in a case database of its own
//! (polyspec-orm-case-database). The test fails when ORM_TEST_POSTGRES_DSN or ORM_TEST_MYSQL_DSN is unset.

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

use std::time::Duration;

use polyspec_orm::{Db, Result};
use polyspec_orm_case_database::CaseDatabase;

/// The channels and the payloads of the case, and the deadline a pending receive is dropped at.
const EVENTS: &str = "t229_events";
const WAIT: Duration = Duration::from_millis(50);

#[tokio::test]
async fn listen_notify() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let database = CaseDatabase::create("postgres").await;
    let db = Db::connect(database.dsn(), 2, polyspec_orm::Config::default()).await.or_panic(|e| format!("postgres: {e}"));

    let mut subscription = db.listen(EVENTS).await.or_panic(|e| format!("postgres: listen: {e}"));
    db.transaction_once(async || -> Result<()> { db.notify(EVENTS, "committed").await })
        .await
        .or_panic(|e| format!("postgres: transaction notify: {e}"));
    let first = subscription.receive_within(Duration::from_secs(10)).await.or_panic(|e| format!("postgres: receive: {e}"));
    assert_eq!((first.channel.as_str(), first.payload.as_str()), (EVENTS, "committed"));

    let rolled = db
        .transaction_once(async || -> std::result::Result<(), std::io::Error> {
            db.notify(EVENTS, "rolled back").await.map_err(std::io::Error::other)?;
            Err(std::io::Error::other("roll back"))
        })
        .await;
    assert!(rolled.is_err(), "postgres: the transaction that fails did not fail");
    db.notify(EVENTS, "outside").await.or_panic(|e| format!("postgres: notify: {e}"));
    let second = subscription.receive_within(Duration::from_secs(10)).await.or_panic(|e| format!("postgres: receive: {e}"));
    assert_eq!(second.payload, "outside", "postgres: the rolled back notification must not arrive");

    // A receive whose deadline expires fails with CANCELED and closes the subscription.
    let expired = subscription.receive_within(WAIT).await.expect_err("postgres: a receive with no notification returned");
    assert_eq!(expired.code(), "CANCELED", "postgres: expired receive");
    let closed = subscription.receive_within(WAIT).await.expect_err("postgres: a receive on a closed subscription");
    assert_eq!(closed.code(), "CONFIG", "postgres: receive after expiry");

    let mut subscription = db.listen(EVENTS).await.or_panic(|e| format!("postgres: listen: {e}"));
    db.notify(EVENTS, "after cancel").await.or_panic(|e| format!("postgres: notify: {e}"));
    let third = subscription.receive_within(Duration::from_secs(10)).await.or_panic(|e| format!("postgres: receive after a cancel: {e}"));
    assert_eq!(third.payload, "after cancel");

    subscription.unlisten(EVENTS).await.or_panic(|e| format!("postgres: unlisten: {e}"));
    db.notify(EVENTS, "after unlisten").await.or_panic(|e| format!("postgres: notify: {e}"));
    subscription.close().await.or_panic(|e| format!("postgres: close: {e}"));
    db.close().await;
    database.drop().await;

    for driver in ["sqlite", "mysql"] {
        let database = CaseDatabase::create(driver).await;
        let db = Db::connect(database.dsn(), 1, polyspec_orm::Config::default()).await.or_panic(|e| format!("{driver}: {e}"));
        let notify = db.notify(EVENTS, "x").await.expect_err("notify");
        assert_eq!(notify.code(), "CAPABILITY_UNSUPPORTED", "{driver}: notify");
        let listen = db.listen(EVENTS).await.err().expect("listen");
        assert_eq!(listen.code(), "CAPABILITY_UNSUPPORTED", "{driver}: listen");
        db.close().await;
        database.drop().await;
    }
}
