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
        None => frames()
            .pop()
            .map(Executor::Tx)
            .ok_or_else(|| Error::Config("the model has no connection; use connect or run it inside a transaction".into())),
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

impl Db {
    /// Runs `f` in one transaction when awaited. An error rolls back; otherwise
    /// the transaction commits. Models without a connection inside `f` use this
    /// transaction. Deadlocks run `f` again, three times by default.
    pub fn transaction<F>(&self, f: F) -> Transaction<'_, F> {
        Transaction { db: self, f, isolation: None, read_only: false, timeout_ms: 0, retry: 3, set: false }
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

    /// Sets the statement timeout in milliseconds (PostgreSQL only).
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
            let tx = Arc::new(begin(self.db, self.isolation, self.read_only, self.timeout_ms).await?);
            let mut stack = frames();
            stack.push(tx.clone());
            let result = FLOW.scope(stack, (self.f)()).await;
            match result {
                Ok(v) => {
                    commit(&tx).await?;
                    return Ok(v);
                }
                Err(e) => {
                    rollback(&tx).await;
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

async fn begin(db: &Db, isolation: Option<Isolation>, read_only: bool, timeout_ms: u64) -> Result<TxShared> {
    if db.inner.closed.load(Ordering::Acquire) {
        return Err(Error::Config("database is closed".into()));
    }
    if timeout_ms > 0 && db.driver() != "postgres" {
        return Err(Error::Engine { code: codes::CAPABILITY_UNSUPPORTED.into(), msg: "transaction timeout_ms is supported only by postgres".into() });
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
            let mut t = p.begin_with(sqlx::AssertSqlSafe(statement).into_sql_str()).await?;
            if timeout_ms > 0 {
                sqlx::raw_sql(sqlx::AssertSqlSafe(format!("SET LOCAL statement_timeout = {timeout_ms}")).into_sql_str()).execute(&mut *t).await?;
            }
            TxInner::Postgres(t)
        }
        Pool::Sqlite(p) => {
            ensure_sqlite_lock_table(db).await?;
            let mut t = p.begin().await?;
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

async fn rollback(tx: &TxShared) {
    tx.finished.store(true, Ordering::Release);
    let mut guard = tx.inner.lock().await;
    if let Some(mut inner) = guard.take() {
        let _ = finish(tx, &mut inner).await;
        let _ = match inner {
            TxInner::MySql(t) => t.rollback().await,
            TxInner::Postgres(t) => t.rollback().await,
            TxInner::Sqlite(t) => t.rollback().await,
        };
    }
}

/// The retryable DEADLOCK error.
pub fn transaction_conflict(message: impl Into<String>) -> Error {
    Error::Engine { code: codes::DEADLOCK.into(), msg: message.into() }
}
