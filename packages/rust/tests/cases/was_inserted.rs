//! INT-53 `backend_waiting_for_lock` with a waiter on PostgreSQL; the recipe utils holds the rest of the utilities of the Rust client,
//! PostgreSQL. The model is the clock fixture (contracts/fixtures/clock.dbs). Each case runs in a case database of its own
//! (polyspec-orm-case-database). The test fails when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.

use crate::clock_test_support;
use clock_test_support::{connected, ClockEvent, OrPanic, CLOCK_SCHEMA};

use polyspec_orm::db::Pool;
use polyspec_orm::{Db, Model, Param, TransactionOptions, Tx, Val};

fn once() -> TransactionOptions {
    TransactionOptions { retry: Some(0), ..Default::default() }
}
use polyspec_orm_case_database::CaseDatabase;

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

/// Takes the LOG message "still waiting for" that a PostgreSQL session of sqlx receives while its statement waits for a lock
/// (T475). sqlx writes each notice of the server as a log record of the target `sqlx::postgres::notice`, at the level trace
/// for the severity LOG; this logger takes only those records and wakes `LOCK_WAITS`, which keeps the wake for a later wait.
struct LockWaits;

static LOCK_WAITS: tokio::sync::Notify = tokio::sync::Notify::const_new();
static LOGGER: LockWaits = LockWaits;

impl log::Log for LockWaits {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.target() == "sqlx::postgres::notice"
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) && record.args().to_string().contains("still waiting for") {
            LOCK_WAITS.notify_one();
        }
    }

    fn flush(&self) {}
}

/// PostgreSQL: a second backend that waits for a row lock is reported. The transaction holds the row, and a task on a second
/// connection, started after the row is held, updates the same row and blocks until the transaction ends. The session of the
/// task reports its lock waits: with deadlock_timeout 1 ms, log_lock_waits on and client_min_messages log, the server sends it
/// the LOG message "still waiting for" while the update waits, and only then the transaction reads the state once (T475).
async fn postgres_waiter(dsn: &str, db: &Db) {
    log::set_logger(&LOGGER).expect("no other logger is set in the test process");
    log::set_max_level(log::LevelFilter::Trace);
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
                let mut waiter = tokio::spawn(async move {
                    let other = Db::connect_schema(&owned, &CLOCK_SCHEMA, 1, polyspec_orm::Config::default()).await.map_err(|e| e.to_string())?;
                    let Pool::Postgres(pool) = other.pool() else { return Err("the waiter is not a PostgreSQL connection".to_owned()) };
                    let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;
                    for setting in ["SET deadlock_timeout = '1ms'", "SET log_lock_waits = on", "SET client_min_messages = log"] {
                        sqlx::raw_sql(setting).execute(&mut *conn).await.map_err(|e| e.to_string())?;
                    }
                    let result = sqlx::query("UPDATE clock_event SET label = 'waiter' WHERE seq = $1")
                        .bind(seq)
                        .execute(&mut *conn)
                        .await
                        .map(|_| ())
                        .map_err(|e| e.to_string());
                    drop(conn);
                    other.close().await;
                    result
                });
                tokio::select! {
                    () = LOCK_WAITS.notified() => {}
                    ended = &mut waiter => panic!("postgres: the waiting update ended before it waited for the row lock: {ended:?}"),
                }
                let waiting = utils.backend_waiting_for_lock().await?;
                Ok((waiting, waiter))
            },
            once(),
        )
        .await
        .or_panic(|e| format!("postgres: {e}"));
    assert!(waiting, "postgres: the waiting backend is reported while the transaction holds the row");
    waiter.await.expect("the waiter ends").unwrap_or_else(|e| panic!("postgres: the waiting update: {e}"));
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
    let _case = polyspec_orm_testcase::case!();
    bounded("postgres").await;
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("was_inserted": was_inserted_postgres)
}
