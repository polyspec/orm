//! Probes the locks that a catalog mutation holds at its `Locked` phase.
//!
//! The mutation calls its publisher synchronously at `Locked`, and the probe runs from that call on a thread and a
//! connection of its own and returns before the publisher does. The mutation is thereby stopped exactly at `Locked`
//! while the probe asks the server, whatever the scheduling: a test that only stops polling the mutation's future can
//! see it run on to its end within one poll when the server answers fast enough, and then probe nothing.
// Each test binary includes this module and uses one of the probes.
#![allow(dead_code)]

use orm_build::tool_db;

/// Runs `probe` with a connection of its own to `dsn` on a new thread and returns its answer.
fn on_own_connection(dsn: &str, probe: impl FnOnce(tool_db::Conn) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool>>> + Send + 'static) -> bool {
    let dsn = dsn.to_owned();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("probe runtime");
        runtime.block_on(async move {
            let (database, connection, _) = tool_db::open(&dsn).await.expect("probe connection");
            let held = probe(connection).await;
            database.close().await;
            held
        })
    })
    .join()
    .expect("probe thread")
}

/// Whether another session is refused the row `id = 0` of `table` (`FOR UPDATE NOWAIT`, or a write without a busy wait
/// on SQLite).
pub fn row_lock_held(dsn: &str, dialect: &str, table: &str) -> bool {
    let (dialect, table) = (dialect.to_owned(), table.to_owned());
    on_own_connection(dsn, move |mut connection| {
        Box::pin(async move {
            if dialect == "sqlite" {
                connection.exec("PRAGMA busy_timeout=0", &[]).await.unwrap();
                return connection.exec(&format!("UPDATE {table} SET n=99 WHERE id=0"), &[]).await.is_err();
            }
            connection.exec(if dialect == "mysql" { "START TRANSACTION" } else { "BEGIN" }, &[]).await.unwrap();
            let refused = connection.exec(&format!("SELECT id FROM {table} WHERE id=0 FOR UPDATE NOWAIT"), &[]).await.is_err();
            connection.exec("ROLLBACK", &[]).await.unwrap();
            refused
        })
    })
}

/// Whether another session is refused an exclusive lock of `table` (`LOCK TABLES … WRITE` with a one-second server
/// lock wait on MySQL, `LOCK TABLE … ACCESS EXCLUSIVE MODE NOWAIT` on PostgreSQL).
pub fn table_lock_held(dsn: &str, dialect: &str, table: &str) -> bool {
    let (dialect, table) = (dialect.to_owned(), table.to_owned());
    on_own_connection(dsn, move |mut connection| {
        Box::pin(async move {
            if dialect == "mysql" {
                // An explicit server failure deadline, not polling or a retry timer.
                connection.exec("SET SESSION lock_wait_timeout=1", &[]).await.unwrap();
                let result = connection.exec(&format!("LOCK TABLES {table} WRITE"), &[]).await;
                if result.is_ok() {
                    connection.exec("UNLOCK TABLES", &[]).await.unwrap();
                }
                return matches!(result, Err(ref error) if error.as_database_error()
                    .and_then(|error| error.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()).is_some_and(|error| error.number() == 1205));
            }
            connection.exec("BEGIN", &[]).await.unwrap();
            let refused = connection.exec(&format!("LOCK TABLE {table} IN ACCESS EXCLUSIVE MODE NOWAIT"), &[]).await.is_err();
            connection.exec("ROLLBACK", &[]).await.unwrap();
            refused
        })
    })
}
