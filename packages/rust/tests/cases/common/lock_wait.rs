//! The events that order a test step after a statement that waits for a lock (T475).
//!
//! PostgreSQL: a session that reports its lock waits (deadlock_timeout 1 ms, log_lock_waits on, client_min_messages log)
//! receives the LOG message "process <pid> still waiting for ..." while its statement waits. sqlx writes each notice of the
//! server as a log record of the target `sqlx::postgres::notice`; the logger of this module passes the records that report a
//! lock wait to every waiter, which waits for the message of its own backend, so cases that run at the same time do not wake
//! each other.
//!
//! MySQL, MariaDB and SQLite send no such message. There the limit of the wait is a setting of the database: a probe session
//! with lock_wait_timeout and innodb_lock_wait_timeout 1 (MySQL, MariaDB) or busy_timeout 1000 ms (SQLite) runs a statement on
//! the held lock after the statement of the client was started, and its answer, 1205 or SQLITE_BUSY, orders the next step.

use std::sync::OnceLock;

use polyspec_orm::db::Pool;
use polyspec_orm::Db;
use tokio::sync::broadcast;

static LOCK_WAITS: OnceLock<broadcast::Sender<String>> = OnceLock::new();

struct LockWaitLogger;

static LOGGER: LockWaitLogger = LockWaitLogger;

impl log::Log for LockWaitLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.target() == "sqlx::postgres::notice"
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let message = record.args().to_string();
        if message.contains("still waiting for") {
            if let Some(sender) = LOCK_WAITS.get() {
                // An error means that no waiter is subscribed, and a message that no waiter reads is left.
                let _woken: usize = sender.send(message).unwrap_or(0);
            }
        }
    }

    fn flush(&self) {}
}

/// The lock waits of one PostgreSQL backend, from the moment of `report` on.
pub struct LockWaits {
    pid: i32,
    receiver: broadcast::Receiver<String>,
}

impl LockWaits {
    /// Makes the session of `conn` report its lock waits and returns its waits. The logger is installed once per process.
    pub async fn report(conn: &mut sqlx::postgres::PgConnection) -> LockWaits {
        let sender = LOCK_WAITS.get_or_init(|| {
            log::set_logger(&LOGGER).expect("no other logger is set in the test process");
            log::set_max_level(log::LevelFilter::Trace);
            broadcast::channel(64).0
        });
        let receiver = sender.subscribe();
        for setting in ["SET deadlock_timeout = '1ms'", "SET log_lock_waits = on", "SET client_min_messages = log"] {
            sqlx::raw_sql(setting).execute(&mut *conn).await.expect("report the lock waits of the session");
        }
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut *conn).await.expect("the backend of the session");
        LockWaits { pid, receiver }
    }

    /// Returns when the server has sent the backend the message that its statement waits for a lock.
    pub async fn waited(&mut self) {
        let own = format!("process {} still waiting for", self.pid);
        loop {
            match self.receiver.recv().await {
                Ok(message) if message.contains(&own) => return,
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => unreachable!("the sender of the lock waits lives as long as the process"),
            }
        }
    }
}

/// Makes the one connection of the pool of `db`, a PostgreSQL pool, report its lock waits; the connection returns to the pool.
pub async fn report_pool_lock_waits(db: &Db) -> LockWaits {
    let Pool::Postgres(pool) = db.pool() else { panic!("the pool is not a PostgreSQL pool") };
    let mut conn = pool.acquire().await.expect("acquire the pool connection");
    let waits = LockWaits::report(&mut conn).await;
    conn.return_to_pool().await;
    waits
}

/// Runs `statement` on a probe session of `dsn` whose lock wait the database ends after one second, and returns when the
/// database has ended it: 1205 on MySQL and MariaDB, SQLITE_BUSY on SQLite. The statement needs a lock that another session
/// holds; a statement that takes its lock, or another error, fails the case.
pub async fn probe_waits(driver: &str, dsn: &str, statement: &str) {
    match driver {
        "sqlite" => {
            let separator = if dsn.contains('?') { '&' } else { '?' };
            let probe = Db::connect(&format!("{dsn}{separator}_pragma=busy_timeout(1000)"), 1, polyspec_orm::Config::default())
                .await
                .unwrap_or_else(|e| panic!("{driver}: open the probe: {e}"));
            let Pool::Sqlite(pool) = probe.pool() else { panic!("{driver}: the probe is not a SQLite pool") };
            let mut conn = pool.acquire().await.unwrap_or_else(|e| panic!("{driver}: acquire the probe: {e}"));
            let ended = sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned())).execute(&mut *conn).await;
            let code = ended.as_ref().err().and_then(|e| e.as_database_error()).and_then(|e| e.code()).map(|code| code.into_owned());
            assert_eq!(code.as_deref(), Some("5"), "{driver}: the probe {statement} ended with {ended:?}, not with SQLITE_BUSY");
            drop(conn);
            probe.close().await;
        }
        "mysql" | "mariadb" => {
            let probe = Db::connect(dsn, 1, polyspec_orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: open the probe: {e}"));
            let Pool::MySql(pool) = probe.pool() else { panic!("{driver}: the probe is not a MySQL pool") };
            let mut conn = pool.acquire().await.unwrap_or_else(|e| panic!("{driver}: acquire the probe: {e}"));
            for setting in ["SET SESSION lock_wait_timeout = 1", "SET SESSION innodb_lock_wait_timeout = 1"] {
                sqlx::raw_sql(setting).execute(&mut *conn).await.unwrap_or_else(|e| panic!("{driver}: {setting}: {e}"));
            }
            let ended = sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned())).execute(&mut *conn).await;
            let number = ended
                .as_ref()
                .err()
                .and_then(|e| e.as_database_error())
                .and_then(|e| e.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>())
                .map(|e| e.number());
            assert_eq!(number, Some(1205), "{driver}: the probe {statement} ended with {ended:?}, not with the lock wait timeout 1205");
            drop(conn);
            probe.close().await;
        }
        other => panic!("{other}: the probe runs on MySQL, MariaDB and SQLite; PostgreSQL reports its lock waits"),
    }
}
