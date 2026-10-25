//! LISTEN and NOTIFY on PostgreSQL (DIA-192 to DIA-196, PRT-74). A notification sent inside a transaction is delivered
//! with its commit and dropped by a rollback; one sent outside a transaction is delivered at once; unlisten stops a
//! channel; a receive whose deadline expires fails with CANCELED and closes the subscription; and MySQL and SQLite refuse
//! notify and listen with CAPABILITY_UNSUPPORTED. Each case runs in a case database of its own
//! (polyspec-orm-case-database). The test fails when ORM_TEST_POSTGRES_DSN or ORM_TEST_MYSQL_DSN is unset.
//! Requirements: DIA-192, DIA-193, DIA-194, DIA-195, DIA-196, PRT-74.

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
    for channel in [String::new(), "x".repeat(64), "é".repeat(32), "bad\0channel".to_owned()] {
        let notify = db.notify(&channel, "invalid channel").await.expect_err("invalid notify channel");
        assert_eq!(notify.code(), "CONFIG", "notify channel {channel:?}");
        let listen = db.listen(&channel).await.err().expect("invalid listen channel");
        assert_eq!(listen.code(), "CONFIG", "listen channel {channel:?}");
    }
    db.notify(&"é".repeat(31), "valid 62-byte channel").await.or_panic(|e| format!("postgres: valid UTF-8 channel: {e}"));
    for payload in ["x".repeat(8000), "x".repeat(8001), "é".repeat(4000), "é".repeat(4001), "bad\0payload".to_owned()] {
        let error = db.notify(EVENTS, &payload).await.expect_err("PostgreSQL rejects this payload");
        assert_eq!(error.code(), "DRIVER", "payload bytes={}", payload.len());
    }
    let boundary = "x".repeat(7999);
    db.transaction_once(async || -> Result<()> { db.notify(EVENTS, "committed").await }).await.or_panic(|e| format!("postgres: transaction notify: {e}"));
    let first = subscription.receive_within(Duration::from_secs(10)).await.or_panic(|e| format!("postgres: receive: {e}"));
    assert_eq!((first.channel.as_str(), first.payload.as_str()), (EVENTS, "committed"));
    db.notify(EVENTS, &boundary).await.or_panic(|e| format!("postgres: 7999-byte payload: {e}"));
    let boundary_received = subscription.receive_within(Duration::from_secs(10)).await.or_panic(|e| format!("postgres: receive 7999-byte payload: {e}"));
    assert_eq!(boundary_received.payload, boundary);
    for payload in ["buffer-1", "buffer-2", "buffer-3"] {
        db.notify(EVENTS, payload).await.or_panic(|e| format!("postgres: buffer notify: {e}"));
    }
    for expected in ["buffer-1", "buffer-2", "buffer-3"] {
        let received = subscription.receive_within(Duration::from_secs(10)).await.or_panic(|e| format!("postgres: buffered receive: {e}"));
        assert_eq!(received.payload, expected, "notifications are buffered in arrival order");
    }

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

    let mut no_delivery = db.listen("t229_unlisten_stops_delivery").await.or_panic(|e| format!("postgres: listen for unlisten: {e}"));
    no_delivery.unlisten("t229_unlisten_stops_delivery").await.or_panic(|e| format!("postgres: unlisten: {e}"));
    db.notify("t229_unlisten_stops_delivery", "must not arrive").await.or_panic(|e| format!("postgres: notify after unlisten: {e}"));
    let expired = no_delivery.receive_within(WAIT).await.expect_err("a notification arrived after unlisten");
    assert_eq!(expired.code(), "CANCELED", "unlisten stopped delivery");
    let closed = no_delivery.receive_within(WAIT).await.expect_err("a closed subscription received another notification");
    assert_eq!(closed.code(), "CONFIG", "receive after expiry is closed");
    no_delivery.close().await.or_panic(|e| format!("postgres: close after expiry: {e}"));

    let mut lost = db.listen("t229_connection_lost").await.or_panic(|e| format!("postgres: listen for connection loss: {e}"));
    let admin = sqlx::PgPool::connect(database.dsn()).await.or_panic(|e| format!("postgres: admin connection: {e}"));
    let pid: i32 = sqlx::query_scalar("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND query = $1 LIMIT 1")
        .bind("LISTEN \"t229_connection_lost\"")
        .fetch_one(&admin)
        .await
        .expect("the listener backend is visible in pg_stat_activity");
    let terminated: bool = sqlx::query_scalar("SELECT pg_terminate_backend($1, 5000)").bind(pid).fetch_one(&admin).await.expect("terminate listener backend");
    assert!(terminated, "the listener backend was terminated");
    let lost_error = lost.receive_within(Duration::from_secs(5)).await.expect_err("receive after connection loss");
    assert_eq!(lost_error.code(), "CONNECTION_LOST");
    let closed = lost.receive_within(WAIT).await.expect_err("receive after connection loss is closed");
    assert_eq!(closed.code(), "CONFIG");
    lost.close().await.or_panic(|e| format!("postgres: close after connection loss: {e}"));
    admin.close().await;
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
