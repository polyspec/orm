//! SQLite locking across processes: several processes commit read-then-write transactions on one file without
//! transaction retries (CFG-42). A recipe case runs on the connections of one test process in Rust.

use crate::or_panic;
use or_panic::OrPanic;

use futures_util::future::join_all;
use polyspec_orm::{Db, Model, Param};

use crate::sqlite_case;
use sqlite_case::{Database, SCHEMA};

async fn database(name: &str) -> Database {
    sqlite_case::database("sqlite-lock", name).await
}

use crate::service_model;
use service_model::service;

/// The database of a writer process started by `writers_in_several_processes`.
const WRITER_DSN: &str = "ORM_SQLITE_WRITER_DSN";
/// The name of that writer process.
const WRITER_NAME: &str = "ORM_SQLITE_WRITER_NAME";

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

#[tokio::main(flavor = "current_thread")]
// Requirements: CFG-42.
async fn writers_in_several_processes() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::PROCESS);
    if let Ok(dsn) = std::env::var(WRITER_DSN) {
        let name = std::env::var(WRITER_NAME).unwrap();
        let failures = run_writers(&open(&dsn, 4).await, &format!("{name}-c"), 20).await;
        assert!(failures.is_empty(), "failed writes: {failures:?}");
        return;
    }
    let file = database("processes").await;
    // The writers wait up to 60 seconds for the file lock (CFG-12), so the load of the runner does not end a wait (CFG-42).
    let dsn = format!("{}?_pragma=busy_timeout(60000)", file.dsn);
    let exe = std::env::current_exe().unwrap();
    let children: Vec<_> = (0..3)
        .map(|i| {
            std::process::Command::new(&exe)
                .args(["sqlite_concurrency::writers_in_several_processes", "--exact", "--test-threads=1"])
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

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("sqlite_concurrency": writers_in_several_processes)
}
