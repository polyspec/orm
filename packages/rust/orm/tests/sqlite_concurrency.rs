//! SQLite locking: several connections and several processes commit
//! read-then-write transactions on one file without transaction retries, a
//! second connection reads while a write transaction is open, and a write that
//! waits longer than busy_timeout returns CANCELED.

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

use std::time::{Duration, Instant};

use futures_util::future::join_all;
use polyspec_orm::{Db, Model, Param};

#[path = "common/sqlite_case.rs"]
mod sqlite_case;
use sqlite_case::{Database, SCHEMA};

async fn database(name: &str) -> Database {
    sqlite_case::database("sqlite-lock", name).await
}

#[macro_use]
#[path = "common/typed_model.rs"]
mod typed_model;

#[path = "common/service_model.rs"]
mod service_model;
use service_model::service;

/// The database of a writer process started by `writers_in_several_processes`.
const WRITER_DSN: &str = "ORM_SQLITE_WRITER_DSN";
/// The name of that writer process.
const WRITER_NAME: &str = "ORM_SQLITE_WRITER_NAME";

/// Holds a write transaction on `holder` that creates one service, and times the write of `waiter` that waits behind it.
/// Returns the code of the waiter's error, if it failed, and how long the write waited.
async fn hold_lock_while_writing(holder: &Db, waiter: &Db) -> (Option<String>, Duration) {
    holder
        .transaction(async || {
            let mut row = service(None);
            row.core_mut().set("name", Param::Str("holder".into()));
            polyspec_orm::model::create(&mut row).await?;
            let started = Instant::now();
            let result = write_service(waiter, "waiter").await;
            Ok((result.err().map(|e| e.code().to_owned()), started.elapsed()))
        })
        .retry(0)
        .await
        .unwrap()
}

/// Runs one transaction that reads the service count and then inserts the service `label`.
async fn write_service(db: &Db, label: &str) -> polyspec_orm::Result<()> {
    db.transaction(async || {
        polyspec_orm::model::get_count(service(None).core()).await?;
        let mut row = service(None);
        row.core_mut().set("name", Param::Str(label.to_owned()));
        polyspec_orm::model::create(&mut row).await?;
        Ok(())
    })
    .retry(0)
    .await
}

/// Runs `n` transactions of `write_service`; a failure names its write.
async fn write_services(db: &Db, name: &str, n: usize) -> Result<(), String> {
    for i in 0..n {
        let label = format!("{name}-{i}");
        write_service(db, &label).await.map_err(|e| format!("{label}: {e}"))?;
    }
    Ok(())
}

/// Opens `count` connections to one SQLite file.
async fn open(dsn: &str, count: usize) -> Vec<Db> {
    let mut out = Vec::new();
    for i in 0..count {
        out.push(Db::connect_schema(dsn, &SCHEMA, 1, polyspec_orm::Config::default()).await.or_panic(|e| format!("connection {i}: {e}")));
    }
    out
}

/// Runs one writer per connection at the same time and returns the failures.
async fn run_writers(dbs: &[Db], prefix: &str, n: usize) -> Vec<String> {
    let runs = dbs.iter().enumerate().map(|(i, db)| async move { write_services(db, &format!("{prefix}{i}"), n).await });
    join_all(runs).await.into_iter().filter_map(Result::err).collect()
}

async fn count(db: &Db) -> i64 {
    polyspec_orm::model::get_count(service(Some(db)).core()).await.unwrap()
}

#[tokio::test]
// Requirements: CFG-19.
async fn dsn_rejects_txlock() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    let path = std::env::temp_dir().join(format!("orm-rust-sqlite-txlock-{}.sqlite", std::process::id()));
    for mode in ["immediate", "deferred"] {
        let result = Db::connect(&format!("sqlite://{}?_txlock={mode}", path.display()), 1, polyspec_orm::Config::default()).await;
        assert_eq!(result.err().map(|e| e.code().to_owned()).as_deref(), Some(polyspec_orm::codes::CONFIG), "_txlock={mode}");
    }
    assert!(!path.exists(), "a rejected DSN created the database file");
}

#[tokio::test]
async fn writers_on_several_connections() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    let file = database("connections").await;
    let dsn = file.dsn.clone();
    let dbs = open(&dsn, 8).await;
    let failures = run_writers(&dbs, "c", 10).await;
    assert!(failures.is_empty(), "failed writes: {failures:?}");
    assert_eq!(count(&dbs[0]).await, 80, "services");
}

#[tokio::test]
async fn writers_in_several_processes() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    if let Ok(dsn) = std::env::var(WRITER_DSN) {
        let name = std::env::var(WRITER_NAME).unwrap();
        let failures = run_writers(&open(&dsn, 4).await, &format!("{name}-c"), 20).await;
        assert!(failures.is_empty(), "failed writes: {failures:?}");
        return;
    }
    let file = database("processes").await;
    let dsn = file.dsn.clone();
    let exe = std::env::current_exe().unwrap();
    let children: Vec<_> = (0..3)
        .map(|i| {
            std::process::Command::new(&exe)
                .args(["writers_in_several_processes", "--exact", "--test-threads=1"])
                .env(WRITER_DSN, &dsn)
                .env(WRITER_NAME, format!("p{i}"))
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    for (i, child) in children.into_iter().enumerate() {
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success(), "writer process {i}: {}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    }
    assert_eq!(count(&open(&dsn, 1).await[0]).await, 240, "services");
}

#[tokio::test]
// Requirements: CFG-13.
async fn reads_during_write() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    let file = database("reads").await;
    let dsn = file.dsn.clone();
    let dbs = open(&dsn, 2).await;
    let (writer, reader) = (&dbs[0], &dbs[1]);
    writer
        .transaction(async || {
            let mut row = service(None);
            row.core_mut().set("name", Param::Str("pending".into()));
            polyspec_orm::model::create(&mut row).await?;
            assert_eq!(count(reader).await, 0, "read during the write");
            let read_only = reader.transaction(async || polyspec_orm::model::get_count(service(None).core()).await).read_only().retry(0).await?;
            assert_eq!(read_only, 0, "read-only transaction during the write");
            Ok(())
        })
        .retry(0)
        .await
        .unwrap();
    assert_eq!(count(reader).await, 1, "read after the write");
}

#[tokio::test]
// Requirements: CFG-12.
async fn lock_wait_expires() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    let file = database("expiry").await;
    let dsn = file.dsn.clone();
    let holder = &open(&dsn, 1).await[0];
    let waiter = &open(&format!("{dsn}?_pragma=busy_timeout(200)"), 1).await[0];
    let (code, waited) = hold_lock_while_writing(holder, waiter).await;
    assert_eq!(code.as_deref(), Some(polyspec_orm::codes::CANCELED), "write past the lock wait");
    assert!(waited >= Duration::from_millis(200), "write returned after {waited:?}, before the 200ms lock wait");
}

#[tokio::test]
async fn statement_timeout_bounds_sqlite_lock_wait() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    let file = database("config-expiry").await;
    let dsn = file.dsn.clone();
    let holder = open(&dsn, 1).await.remove(0);
    let waiter = Db::connect_schema(&dsn, &SCHEMA, 1, polyspec_orm::Config { statement_timeout_ms: 200, ..Default::default() }).await.unwrap();
    let (code, waited) = hold_lock_while_writing(&holder, &waiter).await;
    assert_eq!(code.as_deref(), Some(polyspec_orm::codes::CANCELED), "statement timeout cancels the lock wait");
    assert!(waited >= Duration::from_millis(200), "write returned after {waited:?}, before the 200ms statement timeout");
    waiter.close().await;
    holder.close().await;
}
