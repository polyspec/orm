//! The end of a transaction on a database server (INT-72, INT-67): a cleanup that fails discards its connection and
//! reports every failed step, and a callback that panics or a transaction future that is dropped ends the transaction of
//! its session. These cases need the servers of make orm-test-servers; the ones that kill or watch a server session
//! connect to the servers at ORM_TEST_MYSQL_SERVER_DSN, ORM_TEST_MYSQL_TLS_DSN and ORM_TEST_POSTGRES_SERVER_DSN, not
//! through a pooler, because ProxySQL takes KILL as a command for its own client session.

use std::sync::Arc;

use polyspec_orm::db::Pool;
use polyspec_orm::events::KIND_UTILITY;
use polyspec_orm::{Db, Error, Kind, Result, TransactionOptions, Tx};

use crate::or_panic;
use or_panic::OrPanic;

/// Returns the DSN in `name`; an unset or empty variable fails the test, because database tests never skip.
fn required_dsn(name: &str) -> String {
    match std::env::var(name) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        Ok(_) => panic!("{name} is set but empty; database tests never skip"),
        Err(error) => panic!("{name} is required ({error}); database tests never skip"),
    }
}

fn once() -> TransactionOptions {
    TransactionOptions { retry: Some(0), ..Default::default() }
}

#[tokio::main(flavor = "current_thread")]
// Requirements: INT-72.
async fn failed_cleanup_discards_the_connection() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let db = Db::connect(&required_dsn("ORM_TEST_MYSQL_SERVER_DSN"), 1, polyspec_orm::Config::default()).await.expect("connect");
    let Pool::MySql(pool) = db.pool() else { panic!("MySQL pool") };
    let session = || async {
        let mut conn = pool.acquire().await.expect("pool connection");
        let id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()").fetch_one(&mut *conn).await.expect("connection id");
        id
    };
    let clean = session().await;
    db.transaction(|tx: Tx| async move { tx.utils().lock(&format!("orm_test.clean.{}", std::process::id())).await }, once())
        .await
        .expect("a clean transaction");
    assert_eq!(session().await, clean, "a transaction that ended cleanly keeps its session");
    for fail in [true, false] {
        let before = session().await;
        let key = format!("orm_test.discard.{fail}.{}", std::process::id());
        let key = &key;
        let result = db
            .transaction(
                |tx: Tx| async move {
                    tx.utils().lock(key).await?;
                    // If the lock is released early, RELEASE_LOCK at the end of the transaction returns 0, and the cleanup fails.
                    tx.run(KIND_UTILITY, &[], &format!("DO RELEASE_LOCK('{key}')"), &[]).await?;
                    if fail {
                        return Err(Error::config("callback failed"));
                    }
                    Ok(())
                },
                once(),
            )
            .await;
        assert!(result.is_err(), "the failed cleanup is reported");
        let path = if fail { "rollback" } else { "commit" };
        assert_ne!(session().await, before, "{path}: session {before} returned to the pool after its cleanup failed");
    }
    db.close().await;
}

// Even if RELEASE_LOCK fails, the local value reset is still attempted, and both failures are reported.
#[tokio::main(flavor = "current_thread")]
// Requirements: INT-72.
async fn every_failed_cleanup_step_is_reported() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let db = Db::connect(&required_dsn("ORM_TEST_MYSQL_SERVER_DSN"), 2, polyspec_orm::Config::default()).await.expect("connect");
    let lock = format!("orm_test.killed.{}", std::process::id());
    let cleanup = polyspec_orm::testing::killed_transaction_cleanup(&db, Some(lock)).await.expect_err("the cleanup of a killed connection fails");
    assert_eq!(cleanup.to_string().split("; ").count(), 2, "the release and the reset are both reported: {cleanup}");
    db.close().await;
}

// The transaction of a callback that panicked ends by closing the connection. The server ends that session's transaction and
// named lock, so another connection takes the lock.
#[tokio::main(flavor = "current_thread")]
// Requirements: INT-72.
async fn panicking_callback_ends_its_transaction() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let db = Db::connect(&required_dsn("ORM_TEST_MYSQL_DSN"), 2, polyspec_orm::Config::default()).await.expect("connect");
    let key = format!("orm_test.panicked.{}", std::process::id());
    let key_ref = &key;
    let panicked: Result<()> = db
        .transaction(
            |tx: Tx| async move {
                tx.utils().lock(key_ref).await?;
                panic!("callback panicked")
            },
            once(),
        )
        .await;
    assert!(matches!(&panicked, Err(error) if error.kind() == Kind::Internal), "the callback panics: {panicked:?}");
    let Pool::MySql(pool) = db.pool() else { panic!("MySQL pool") };
    let mut other = pool.acquire().await.expect("another connection");
    // The server waits until the closed session's lock is released.
    let got: Option<i64> = sqlx::query_scalar("SELECT GET_LOCK(?, 5)").bind(&key).fetch_one(&mut *other).await.expect("GET_LOCK");
    assert_eq!(got, Some(1), "the panicked transaction released its lock");
    let released: Option<i64> = sqlx::query_scalar("SELECT RELEASE_LOCK(?)").bind(&key).fetch_one(&mut *other).await.expect("RELEASE_LOCK");
    assert_eq!(released, Some(1));
    drop(other);
    db.close().await;
}

async fn execute(db: &Db, statement: &str) {
    match db.pool() {
        Pool::MySql(pool) => sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned())).execute(pool).await.map(|_| ()),
        Pool::Postgres(pool) => sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned())).execute(pool).await.map(|_| ()),
        Pool::Sqlite(pool) => sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned())).execute(pool).await.map(|_| ()),
        Pool::Markdown(_) => unreachable!("the transaction tests connect to SQL databases"),
    }
    .or_panic(|e| format!("{statement}: {e}"));
}

// A transaction future dropped before it finished closes the connection. The server ends that session's
// transaction and lock, so another connection takes the lock. The MySQL connection uses TLS, through the ssl-mode of
// ORM_TEST_MYSQL_TLS_DSN (a DSN without ssl-mode connects without TLS, CFG-44), since sqlx's TLS stream shutdown
// waits for data the server does not send. This test watches the end of a server session, so it connects to the
// servers at ORM_TEST_MYSQL_TLS_DSN and ORM_TEST_POSTGRES_SERVER_DSN, not through a pooler.
// On SQLite, the write transaction of the closed connection ends, so another connection takes the write lock.
#[tokio::main(flavor = "current_thread")]
// Requirements: INT-72, INT-67.
async fn dropped_transaction_closes_its_connection() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let tmp = std::env::temp_dir().join(format!("orm-rust-dropped-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).or_panic(|e| format!("create {}: {e}", tmp.display()));
    let targets = [
        ("sqlite", format!("sqlite://{}", tmp.join("dropped.sqlite").display())),
        ("mysql", required_dsn("ORM_TEST_MYSQL_TLS_DSN")),
        ("postgres", required_dsn("ORM_TEST_POSTGRES_SERVER_DSN")),
    ];
    for (driver, dsn) in targets {
        let db = Db::connect(&dsn, 2, polyspec_orm::Config::default()).await.or_panic(|e| format!("{driver}: {e}"));
        match db.pool() {
            Pool::MySql(pool) => {
                let cipher: (String, String) = sqlx::query_as("SHOW SESSION STATUS LIKE 'Ssl_cipher'").fetch_one(pool).await.expect("Ssl_cipher");
                assert!(!cipher.1.is_empty(), "the MySQL test connection uses TLS");
            }
            Pool::Sqlite(_) => execute(&db, "CREATE TABLE orm_dropped_probe (id INTEGER PRIMARY KEY)").await,
            Pool::Postgres(_) => {}
            Pool::Markdown(_) => unreachable!("the transaction tests connect to SQL databases"),
        }
        let key = format!("orm_test.dropped.{}", std::process::id());
        let held = Arc::new(tokio::sync::Notify::new());
        let (key_ref, held_ref) = (&key, &held);
        let transaction = db.transaction(
            |tx: Tx| async move {
                tx.utils().lock(key_ref).await?;
                if driver == "sqlite" {
                    tx.run(KIND_UTILITY, &[], "INSERT INTO orm_dropped_probe (id) VALUES (1)", &[]).await?;
                }
                held_ref.notify_one();
                std::future::pending::<()>().await;
                Ok::<(), Error>(())
            },
            once(),
        );
        tokio::select! {
            result = transaction => panic!("{driver}: the transaction ended before the drop: {result:?}"),
            _ = held.notified() => {}
        }
        // The server waits up to 5 seconds for the closed session's lock to be released.
        match db.pool() {
            Pool::MySql(pool) => {
                let mut other = pool.acquire().await.expect("another connection");
                let got: Option<i64> = sqlx::query_scalar("SELECT GET_LOCK(?, 5)").bind(&key).fetch_one(&mut *other).await.expect("GET_LOCK");
                assert_eq!(got, Some(1), "mysql: the dropped transaction released its lock");
                let released: Option<i64> = sqlx::query_scalar("SELECT RELEASE_LOCK(?)").bind(&key).fetch_one(&mut *other).await.expect("RELEASE_LOCK");
                assert_eq!(released, Some(1));
            }
            Pool::Postgres(pool) => {
                let mut other = pool.begin().await.expect("another transaction");
                sqlx::raw_sql("SET LOCAL lock_timeout = '5s'").execute(&mut *other).await.expect("lock_timeout");
                sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
                    .bind(&key)
                    .execute(&mut *other)
                    .await
                    .expect("postgres: the dropped transaction released its lock");
                other.rollback().await.expect("rollback");
            }
            Pool::Sqlite(pool) => {
                let mut other = pool.acquire().await.expect("another connection");
                sqlx::raw_sql("PRAGMA busy_timeout = 5000").execute(&mut *other).await.expect("busy_timeout");
                sqlx::raw_sql("BEGIN IMMEDIATE").execute(&mut *other).await.expect("sqlite: the dropped transaction released its write lock");
                let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM orm_dropped_probe").fetch_one(&mut *other).await.expect("count");
                assert_eq!(rows, 0, "sqlite: the dropped transaction rolled back");
                sqlx::raw_sql("ROLLBACK").execute(&mut *other).await.expect("rollback");
            }
            Pool::Markdown(_) => unreachable!("the transaction tests connect to SQL databases"),
        }
        db.close().await;
    }
    std::fs::remove_dir_all(&tmp).or_panic(|e| format!("remove {}: {e}", tmp.display()));
}

// If the MySQL local value reset at the end of the transaction fails, that error is reported. The MySQL user
// variable remains after COMMIT and ROLLBACK (mysql.context.user_variable_session_scope).
#[tokio::main(flavor = "current_thread")]
// Requirements: INT-72.
async fn failed_local_reset_is_reported() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let db = Db::connect(&required_dsn("ORM_TEST_MYSQL_SERVER_DSN"), 2, polyspec_orm::Config::default()).await.expect("connect");
    let reset = polyspec_orm::testing::killed_transaction_cleanup(&db, None).await;
    assert!(reset.is_err(), "the reset of a killed connection is reported: {reset:?}");
    let ended = polyspec_orm::testing::killed_transaction_rollback(&db).await.expect_err("the rollback of a killed connection reports the reset");
    assert!(ended.to_string().contains("transaction cleanup failed"), "{ended}");
    db.close().await;
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("transaction_end": failed_cleanup_discards_the_connection, every_failed_cleanup_step_is_reported, panicking_callback_ends_its_transaction, dropped_transaction_closes_its_connection, failed_local_reset_is_reported)
}
