//! Callback transactions. Each task keeps a stack of active transactions; a
//! model without a connection runs in the innermost one. A transaction of the
//! same connection inside an active one creates a savepoint.

use std::collections::HashMap;
use std::future::{Future, IntoFuture};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use sqlx::SqlSafeStr as _;

use crate::db::{Db, Executor, Pool};
use crate::driver::{MySqlOwnedTx, TxInner};
use crate::{codes, Error, Result};

/// One active transaction.
pub(crate) struct TxShared {
    pub(crate) db: Db,
    pub(crate) inner: tokio::sync::Mutex<Option<TxInner>>,
    pub(crate) finished: AtomicBool,
    savepoints: AtomicU32,
    pub(crate) locals: Mutex<HashMap<String, String>>,
    pub(crate) locks: Mutex<Vec<String>>,
    pub(crate) context_row: AtomicBool,
    sqlite_mode: Mutex<Option<(bool, bool)>>,
}

impl TxShared {
    /// Marks the start of a statement; the transaction rejects concurrent use.
    pub(crate) fn enter(&self) -> Result<tokio::sync::MutexGuard<'_, Option<TxInner>>> {
        if self.finished.load(Ordering::Acquire) {
            return Err(Error::Config("transaction already finished".into()));
        }
        self.inner.try_lock().map_err(|_| Error::Config("the transaction connection is already in use".into()))
    }

    /// Runs a statement text on the transaction connection.
    pub(crate) async fn raw(&self, sql: &str) -> Result<()> {
        let mut guard = self.enter()?;
        let inner = guard.as_mut().ok_or_else(|| Error::Config("transaction already finished".into()))?;
        raw_on(inner, sql).await
    }
}

pub(crate) async fn raw_on(inner: &mut TxInner, sql: &str) -> Result<()> {
    let statement = sqlx::AssertSqlSafe(sql.to_owned()).into_sql_str();
    match inner {
        TxInner::MySql(t) => {
            sqlx::raw_sql(statement).execute(&mut **t.conn.as_mut().expect("active MySQL transaction connection")).await?;
        }
        TxInner::Postgres(t) => {
            sqlx::raw_sql(statement).execute(&mut **t).await?;
        }
        TxInner::Sqlite(t) => {
            sqlx::raw_sql(statement).execute(&mut **t).await?;
        }
    }
    Ok(())
}

tokio::task_local! {
    static FLOW: Vec<Arc<TxShared>>;
}

fn frames() -> Vec<Arc<TxShared>> {
    FLOW.try_with(|f| f.clone()).unwrap_or_default()
}

/// The innermost active transaction of a connection in this task.
pub(crate) fn active_for(db: &Db) -> Option<Arc<TxShared>> {
    frames().into_iter().rev().find(|t| t.db.id() == db.id())
}

/// Selects where a model runs: the active transaction of its connection, the
/// connection, or the innermost active transaction when it has none.
pub(crate) fn resolve(conn: &Option<Db>) -> Result<Executor> {
    match conn {
        Some(db) => Ok(match active_for(db) {
            Some(t) => Executor::Tx(t),
            None => Executor::Db(db.clone()),
        }),
        None => frames().pop().map(Executor::Tx).ok_or_else(|| Error::Config("the model has no connection; use connect or run it inside a transaction".into())),
    }
}

/// A transaction isolation level.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Isolation {
    ReadUncommitted,
    ReadCommitted,
    RepeatableRead,
    Serializable,
}

impl Isolation {
    fn sql(self) -> &'static str {
        match self {
            Isolation::ReadUncommitted => "READ UNCOMMITTED",
            Isolation::ReadCommitted => "READ COMMITTED",
            Isolation::RepeatableRead => "REPEATABLE READ",
            Isolation::Serializable => "SERIALIZABLE",
        }
    }
}

/// A transaction run: configure it with the option methods and await it.
pub struct Transaction<'a, F> {
    db: &'a Db,
    f: F,
    isolation: Option<Isolation>,
    read_only: bool,
    timeout_ms: u64,
    retry: u32,
    set: bool,
}

/// Failure of a callback transaction that runs exactly once.
#[derive(Debug)]
pub enum TransactionOnceError<E> {
    /// The database could not start, commit, or complete the transaction.
    Orm(Error),
    /// The callback failed and its transaction rolled back.
    Callback(E),
    /// Both the callback and rollback failed.
    Rollback { callback: E, rollback: Error },
}

impl<E: std::fmt::Display> std::fmt::Display for TransactionOnceError<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Orm(error) => write!(f, "transaction failed: {error}"),
            Self::Callback(error) => write!(f, "transaction callback failed: {error}"),
            Self::Rollback { callback, rollback } => {
                write!(f, "transaction callback failed ({callback}) and rollback failed ({rollback})")
            }
        }
    }
}

impl<E: std::error::Error + Send + Sync + 'static> std::error::Error for TransactionOnceError<E> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Orm(error) => Some(error),
            Self::Callback(error) | Self::Rollback { callback: error, .. } => Some(error),
        }
    }
}

impl Db {
    /// Runs `f` in one transaction when awaited. An error rolls back; otherwise
    /// the transaction commits. Models without a connection inside `f` use this
    /// transaction. Deadlocks run `f` again, three times by default.
    pub fn transaction<F>(&self, f: F) -> Transaction<'_, F> {
        Transaction { db: self, f, isolation: None, read_only: false, timeout_ms: 0, retry: 3, set: false }
    }

    /// Runs a callback once in a transaction and preserves its own error.
    /// A nested call uses a savepoint. This call does not retry the callback.
    pub async fn transaction_once<F, T, E>(&self, f: F) -> std::result::Result<T, TransactionOnceError<E>>
    where
        F: AsyncFnOnce() -> std::result::Result<T, E>,
    {
        if let Some(outer) = active_for(self) {
            return savepoint_once(outer, f).await;
        }
        let tx = Arc::new(begin(self, None, false).await.map_err(TransactionOnceError::Orm)?);
        let mut stack = frames();
        stack.push(tx.clone());
        match FLOW.scope(stack, f()).await {
            Ok(value) => {
                commit(&tx).await.map_err(TransactionOnceError::Orm)?;
                Ok(value)
            }
            Err(callback) => match rollback(&tx).await {
                Ok(()) => Err(TransactionOnceError::Callback(callback)),
                Err(rollback) => Err(TransactionOnceError::Rollback { callback, rollback }),
            },
        }
    }
}

impl<'a, F> Transaction<'a, F> {
    /// Sets the isolation level.
    pub fn isolation(mut self, level: Isolation) -> Self {
        self.isolation = Some(level);
        self.set = true;
        self
    }

    /// Makes the transaction read-only.
    pub fn read_only(mut self) -> Self {
        self.read_only = true;
        self.set = true;
        self
    }

    /// Bounds execution of the transaction callback in milliseconds. On
    /// expiry, the callback is cancelled and its transaction is rolled back.
    /// Zero disables the bound.
    pub fn timeout_ms(mut self, ms: u64) -> Self {
        self.timeout_ms = ms;
        self.set = true;
        self
    }

    /// Sets how many times a deadlocked callback runs again; 0 disables retry.
    pub fn retry(mut self, n: u32) -> Self {
        self.retry = n;
        self
    }
}

impl<'a, F, T> IntoFuture for Transaction<'a, F>
where
    F: AsyncFn() -> Result<T> + 'a,
    T: 'a,
{
    type Output = Result<T>;
    type IntoFuture = Pin<Box<dyn Future<Output = Result<T>> + 'a>>;

    fn into_future(self) -> Self::IntoFuture {
        Box::pin(async move { self.run().await })
    }
}

impl<'a, F> Transaction<'a, F> {
    async fn run<T>(self) -> Result<T>
    where
        F: AsyncFn() -> Result<T>,
    {
        if let Some(outer) = active_for(self.db) {
            if self.set {
                return Err(Error::Config("a nested transaction of the same connection accepts only the retry option".into()));
            }
            return savepoint(outer, &self.f).await;
        }
        let mut attempt = 0u32;
        loop {
            let tx = Arc::new(begin(self.db, self.isolation, self.read_only).await?);
            let mut stack = frames();
            stack.push(tx.clone());
            let callback = FLOW.scope(stack, (self.f)());
            let result = if self.timeout_ms == 0 {
                callback.await
            } else {
                match tokio::time::timeout(std::time::Duration::from_millis(self.timeout_ms), callback).await {
                    Ok(result) => result,
                    Err(_) => Err(Error::Engine { code: codes::CANCELED.into(), msg: "transaction callback timed out".into() }),
                }
            };
            match result {
                Ok(v) => {
                    commit(&tx).await?;
                    return Ok(v);
                }
                Err(e) => {
                    if let Err(rollback_error) = rollback(&tx).await {
                        return Err(Error::Config(format!("transaction failed ({e}) and rollback failed ({rollback_error})")));
                    }
                    if !e.is_deadlock() || attempt >= self.retry {
                        return Err(e);
                    }
                    let jitter = rand::random::<u64>() % 20;
                    tokio::time::sleep(std::time::Duration::from_millis((50u64 << attempt.min(10)) + jitter)).await;
                    attempt += 1;
                }
            }
        }
    }
}

async fn savepoint<T, F>(tx: Arc<TxShared>, f: &F) -> Result<T>
where
    F: AsyncFn() -> Result<T>,
{
    let n = tx.savepoints.fetch_add(1, Ordering::AcqRel) + 1;
    let name = format!("orm_sp_{n}");
    let result = async {
        tx.raw(&format!("SAVEPOINT {name}")).await?;
        let mut stack = frames();
        stack.push(tx.clone());
        match FLOW.scope(stack, f()).await {
            Ok(v) => {
                tx.raw(&format!("RELEASE SAVEPOINT {name}")).await?;
                Ok(v)
            }
            Err(e) => {
                tx.raw(&format!("ROLLBACK TO SAVEPOINT {name}")).await?;
                let _ = tx.raw(&format!("RELEASE SAVEPOINT {name}")).await;
                Err(e)
            }
        }
    }
    .await;
    tx.savepoints.fetch_sub(1, Ordering::AcqRel);
    result
}

async fn savepoint_once<F, T, E>(tx: Arc<TxShared>, f: F) -> std::result::Result<T, TransactionOnceError<E>>
where
    F: AsyncFnOnce() -> std::result::Result<T, E>,
{
    let n = tx.savepoints.fetch_add(1, Ordering::AcqRel) + 1;
    let name = format!("orm_sp_{n}");
    let result = async {
        tx.raw(&format!("SAVEPOINT {name}")).await.map_err(TransactionOnceError::Orm)?;
        let mut stack = frames();
        stack.push(tx.clone());
        match FLOW.scope(stack, f()).await {
            Ok(value) => {
                tx.raw(&format!("RELEASE SAVEPOINT {name}")).await.map_err(TransactionOnceError::Orm)?;
                Ok(value)
            }
            Err(callback) => {
                let rolled_back = tx.raw(&format!("ROLLBACK TO SAVEPOINT {name}")).await;
                let released = tx.raw(&format!("RELEASE SAVEPOINT {name}")).await;
                match (rolled_back, released) {
                    (Ok(()), Ok(())) => Err(TransactionOnceError::Callback(callback)),
                    (Err(rollback), Ok(())) | (Ok(()), Err(rollback)) => Err(TransactionOnceError::Rollback { callback, rollback }),
                    (Err(rollback), Err(release)) => Err(TransactionOnceError::Rollback {
                        callback,
                        rollback: Error::Config(format!("savepoint rollback failed ({rollback}) and release failed ({release})")),
                    }),
                }
            }
        }
    }
    .await;
    tx.savepoints.fetch_sub(1, Ordering::AcqRel);
    result
}

async fn begin(db: &Db, isolation: Option<Isolation>, read_only: bool) -> Result<TxShared> {
    if db.inner.closed.load(Ordering::Acquire) {
        return Err(Error::Config("database is closed".into()));
    }
    let level = isolation.map(Isolation::sql);
    let mut sqlite_mode = None;
    let inner = match db.pool() {
        Pool::MySql(p) => {
            let mut conn = p.acquire().await?;
            if let Some(level) = level {
                sqlx::raw_sql(sqlx::AssertSqlSafe(format!("SET TRANSACTION ISOLATION LEVEL {level}")).into_sql_str()).execute(&mut *conn).await?;
            }
            let start = if read_only { "START TRANSACTION READ ONLY" } else { "START TRANSACTION" };
            sqlx::raw_sql(start).execute(&mut *conn).await?;
            TxInner::MySql(MySqlOwnedTx { conn: Some(conn) })
        }
        Pool::Postgres(p) => {
            let mut statement = String::from("BEGIN");
            if let Some(level) = level {
                statement.push_str(" ISOLATION LEVEL ");
                statement.push_str(level);
            }
            if read_only {
                statement.push_str(" READ ONLY");
            }
            let t = p.begin_with(sqlx::AssertSqlSafe(statement).into_sql_str()).await?;
            TxInner::Postgres(t)
        }
        Pool::Sqlite(p) => {
            ensure_sqlite_lock_table(db).await?;
            // A write transaction holds the write lock from its start and waits
            // for it up to busy_timeout; a read-only one begins deferred.
            let mut t = p.begin_with(if read_only { "BEGIN" } else { "BEGIN IMMEDIATE" }).await?;
            let uncommitted = isolation == Some(Isolation::ReadUncommitted);
            if uncommitted {
                sqlx::raw_sql("PRAGMA read_uncommitted = 1").execute(&mut *t).await?;
            }
            if read_only {
                sqlx::raw_sql("PRAGMA query_only = 1").execute(&mut *t).await?;
            }
            if uncommitted || read_only {
                sqlite_mode = Some((uncommitted, read_only));
            }
            TxInner::Sqlite(t)
        }
    };
    Ok(TxShared {
        db: db.clone(),
        inner: tokio::sync::Mutex::new(Some(inner)),
        finished: AtomicBool::new(false),
        savepoints: AtomicU32::new(0),
        locals: Mutex::new(HashMap::new()),
        locks: Mutex::new(Vec::new()),
        context_row: AtomicBool::new(false),
        sqlite_mode: Mutex::new(sqlite_mode),
    })
}

async fn ensure_sqlite_lock_table(db: &Db) -> Result<()> {
    if db.inner.sqlite_lock_ready.load(Ordering::Acquire) {
        return Ok(());
    }
    if let Pool::Sqlite(p) = db.pool() {
        sqlx::raw_sql("CREATE TABLE IF NOT EXISTS \"orm__row_lock\" (\"id\" INTEGER PRIMARY KEY CHECK (\"id\" = 1))").execute(p).await?;
        db.inner.sqlite_lock_ready.store(true, Ordering::Release);
    }
    Ok(())
}

/// Releases named locks, resets session values, and leaves SQLite modes before
/// the transaction ends.
async fn finish(tx: &TxShared, inner: &mut TxInner) -> Result<()> {
    let locks: Vec<String> = std::mem::take(&mut *tx.locks.lock().unwrap());
    if let TxInner::MySql(t) = inner {
        let conn = &mut **t.conn.as_mut().expect("active MySQL transaction connection");
        for key in locks {
            sqlx::query("SELECT RELEASE_LOCK(?)").bind(key).execute(&mut *conn).await?;
        }
        let keys: Vec<String> = tx.locals.lock().unwrap().keys().cloned().collect();
        for key in keys {
            raw_on_conn(conn, &format!("SET @`orm.{key}` = NULL")).await?;
        }
    }
    if let TxInner::Sqlite(t) = inner {
        let mode = tx.sqlite_mode.lock().unwrap().take();
        if let Some((uncommitted, read_only)) = mode {
            if read_only {
                sqlx::raw_sql("PRAGMA query_only = 0").execute(&mut **t).await?;
            }
            if uncommitted {
                sqlx::raw_sql("PRAGMA read_uncommitted = 0").execute(&mut **t).await?;
            }
        }
    }
    Ok(())
}

async fn raw_on_conn(conn: &mut sqlx::MySqlConnection, sql: &str) -> Result<()> {
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned()).into_sql_str()).execute(conn).await?;
    Ok(())
}

async fn commit(tx: &TxShared) -> Result<()> {
    tx.finished.store(true, Ordering::Release);
    let mut guard = tx.inner.lock().await;
    let Some(mut inner) = guard.take() else {
        return Err(Error::Config("transaction already finished".into()));
    };
    if tx.context_row.load(Ordering::Acquire) {
        raw_on(&mut inner, "DELETE FROM \"orm__context\"").await?;
    }
    finish(tx, &mut inner).await?;
    match inner {
        TxInner::MySql(t) => t.commit().await?,
        TxInner::Postgres(t) => t.commit().await?,
        TxInner::Sqlite(t) => t.commit().await?,
    }
    Ok(())
}

async fn rollback(tx: &TxShared) -> Result<()> {
    tx.finished.store(true, Ordering::Release);
    let mut guard = tx.inner.lock().await;
    let Some(mut inner) = guard.take() else {
        return Err(Error::Config("transaction already finished".into()));
    };
    let cleanup = finish(tx, &mut inner).await;
    let rolled_back = match inner {
        TxInner::MySql(t) => t.rollback().await,
        TxInner::Postgres(t) => t.rollback().await,
        TxInner::Sqlite(t) => t.rollback().await,
    };
    match (cleanup, rolled_back) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(e), Ok(())) => Err(e),
        (Ok(()), Err(e)) => Err(e.into()),
        (Err(cleanup), Err(rollback)) => Err(Error::Config(format!("transaction cleanup failed ({cleanup}) and rollback failed ({rollback})"))),
    }
}

/// The retryable DEADLOCK error.
pub fn transaction_conflict(message: impl Into<String>) -> Error {
    Error::Engine { code: codes::DEADLOCK.into(), msg: message.into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, Eq)]
    enum DomainFailure {
        Rejected,
    }

    impl std::fmt::Display for DomainFailure {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("request rejected")
        }
    }

    impl std::error::Error for DomainFailure {}

    #[test]
    fn one_shot_transaction_reports_callback_and_rollback_errors() {
        let error = TransactionOnceError::Rollback { callback: DomainFailure::Rejected, rollback: Error::Config("rollback rejected".into()) };
        assert!(error.to_string().contains("request rejected"));
        assert!(error.to_string().contains("rollback rejected"));
        assert_eq!(std::error::Error::source(&error).unwrap().to_string(), "request rejected");
    }

    #[tokio::test]
    async fn one_shot_transaction_preserves_callback_error_and_rolls_back() {
        let tmp = std::env::temp_dir().join(format!("orm-once-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let targets = [
            ("sqlite", format!("sqlite://{}", tmp.join("once.sqlite").display())),
            ("mysql", required_dsn("ORM_TEST_MYSQL_DSN")),
            ("postgres", required_dsn("ORM_TEST_POSTGRES_DSN")),
        ];
        for (driver, dsn) in targets {
            let db = Db::connect(&dsn, 2, crate::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
            execute(&db, "DROP TABLE IF EXISTS orm_once_probe").await;
            execute(&db, "CREATE TABLE orm_once_probe (id INTEGER PRIMARY KEY)").await;
            let result = db
                .transaction_once(async || {
                    active_for(&db).expect("transaction active").raw("INSERT INTO orm_once_probe (id) VALUES (1)").await.unwrap();
                    Err::<(), _>(DomainFailure::Rejected)
                })
                .await;
            assert!(matches!(result, Err(TransactionOnceError::Callback(DomainFailure::Rejected))), "{driver}: {result:?}");
            let count = match db.pool() {
                Pool::MySql(pool) => sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM orm_once_probe").fetch_one(pool).await.unwrap(),
                Pool::Postgres(pool) => sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM orm_once_probe").fetch_one(pool).await.unwrap(),
                Pool::Sqlite(pool) => sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM orm_once_probe").fetch_one(pool).await.unwrap(),
            };
            assert_eq!(count, 0, "{driver}: rollback");
            db.transaction_once(async || {
                active_for(&db).expect("transaction active").raw("INSERT INTO orm_once_probe (id) VALUES (2)").await.unwrap();
                Ok::<_, DomainFailure>(())
            })
            .await
            .unwrap_or_else(|e| panic!("{driver}: commit: {e:?}"));
            db.transaction(async || {
                active_for(&db).expect("transaction active").raw("INSERT INTO orm_once_probe (id) VALUES (3)").await?;
                let nested = db
                    .transaction_once(async || {
                        active_for(&db).expect("transaction active").raw("INSERT INTO orm_once_probe (id) VALUES (4)").await.unwrap();
                        Err::<(), _>(DomainFailure::Rejected)
                    })
                    .await;
                assert!(matches!(nested, Err(TransactionOnceError::Callback(DomainFailure::Rejected))), "{driver}: {nested:?}");
                active_for(&db).expect("transaction active").raw("INSERT INTO orm_once_probe (id) VALUES (5)").await
            })
            .retry(0)
            .await
            .unwrap_or_else(|e| panic!("{driver}: nested transaction: {e}"));
            let count = match db.pool() {
                Pool::MySql(pool) => sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM orm_once_probe").fetch_one(pool).await.unwrap(),
                Pool::Postgres(pool) => sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM orm_once_probe").fetch_one(pool).await.unwrap(),
                Pool::Sqlite(pool) => sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM orm_once_probe").fetch_one(pool).await.unwrap(),
            };
            assert_eq!(count, 3, "{driver}: committed rows");
            execute(&db, "DROP TABLE orm_once_probe").await;
            db.close().await;
        }
        std::fs::remove_dir_all(tmp).unwrap();
    }

    fn required_dsn(name: &str) -> String {
        std::env::var(name).ok().filter(|dsn| !dsn.is_empty()).unwrap_or_else(|| panic!("{name} is required; database tests never skip"))
    }

    async fn execute(db: &Db, statement: &str) {
        match db.pool() {
            Pool::MySql(pool) => sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned())).execute(pool).await.map(|_| ()),
            Pool::Postgres(pool) => sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned())).execute(pool).await.map(|_| ()),
            Pool::Sqlite(pool) => sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned())).execute(pool).await.map(|_| ()),
        }
        .unwrap();
    }

    async fn count(db: &Db) -> i64 {
        match db.pool() {
            Pool::MySql(pool) => sqlx::query_scalar("SELECT COUNT(*) FROM orm_timeout_probe").fetch_one(pool).await,
            Pool::Postgres(pool) => sqlx::query_scalar("SELECT COUNT(*) FROM orm_timeout_probe").fetch_one(pool).await,
            Pool::Sqlite(pool) => sqlx::query_scalar("SELECT COUNT(*) FROM orm_timeout_probe").fetch_one(pool).await,
        }
        .unwrap()
    }

    #[tokio::test]
    async fn callback_timeout_cancels_a_statement_and_rolls_back() {
        let tmp = std::env::temp_dir().join(format!("orm-timeout-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let targets = [
            ("sqlite", format!("sqlite://{}", tmp.join("timeout.sqlite").display())),
            ("mysql", required_dsn("ORM_TEST_MYSQL_DSN")),
            ("postgres", required_dsn("ORM_TEST_POSTGRES_DSN")),
        ];
        for (driver, dsn) in targets {
            let db = Db::connect(&dsn, 2, crate::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
            execute(&db, "DROP TABLE IF EXISTS orm_timeout_probe").await;
            execute(&db, "CREATE TABLE orm_timeout_probe (id INTEGER PRIMARY KEY)").await;
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                db.transaction(async || {
                    let tx = active_for(&db).expect("transaction is active");
                    tx.raw("INSERT INTO orm_timeout_probe (id) VALUES (1)").await?;
                    match driver {
                        "mysql" => tx.raw("SELECT SLEEP(0.2)").await?,
                        "postgres" => tx.raw("SELECT pg_sleep(0.2)").await?,
                        "sqlite" => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
                        _ => unreachable!(),
                    }
                    Ok(())
                })
                .timeout_ms(20)
                .retry(0),
            )
            .await
            .expect("transaction test timed out");
            assert_eq!(result.unwrap_err().code(), codes::CANCELED, "{driver}: timeout code");
            assert_eq!(count(&db).await, 0, "{driver}: transaction rolled back");
            db.transaction(async || active_for(&db).expect("transaction is active").raw("INSERT INTO orm_timeout_probe (id) VALUES (2)").await)
                .retry(0)
                .await
                .unwrap_or_else(|e| panic!("{driver}: next transaction: {e}"));
            assert_eq!(count(&db).await, 1, "{driver}: next transaction committed");
            db.transaction(async || {
                active_for(&db).expect("transaction is active").raw("INSERT INTO orm_timeout_probe (id) VALUES (3)").await?;
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                Ok(())
            })
            .timeout_ms(0)
            .retry(0)
            .await
            .unwrap_or_else(|e| panic!("{driver}: zero deadline: {e}"));
            assert_eq!(count(&db).await, 2, "{driver}: zero disables the deadline");
            execute(&db, "DROP TABLE orm_timeout_probe").await;
            db.close().await;
        }
        std::fs::remove_dir_all(tmp).unwrap();
    }
}
