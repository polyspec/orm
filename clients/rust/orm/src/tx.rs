//! Callback transactions. Each task keeps a stack of active transactions; a
//! model without a connection runs in the innermost one. A transaction of the
//! same connection inside an active one creates a savepoint.

use std::collections::HashMap;
use std::future::{Future, IntoFuture};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt as _;
use sqlx::SqlSafeStr as _;

use crate::db::{Db, Executor, Pool};
use crate::driver::{CancellableConnection, MySqlOwnedTx, TxInner};
use crate::{codes, Error, Result};

/// One active transaction.
pub(crate) struct TxShared {
    pub(crate) db: Db,
    pub(crate) inner: tokio::sync::Mutex<Option<TxInner>>,
    pub(crate) finished: AtomicBool,
    savepoints: AtomicU32,
    pub(crate) locals: Mutex<HashMap<String, String>>,
    pub(crate) locks: Mutex<Vec<String>>,
    /// unit of work의 operation id. executor가 audit 대상 row의 operation column에 쓴다.
    pub(crate) operation: Option<OperationId>,
    sqlite_mode: Mutex<Option<(bool, bool)>>,
}

/// unit of work의 operation id (docs/dbspec.md, "Audit"). audit operation column의
/// type에 맞춰 `i64` column은 `I64`, `uuid` column은 소문자 canonical text의 `Uuid`를 받는다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OperationId {
    I64(i64),
    Uuid(String),
}

impl From<i64> for OperationId {
    fn from(id: i64) -> Self {
        OperationId::I64(id)
    }
}

impl From<String> for OperationId {
    fn from(id: String) -> Self {
        OperationId::Uuid(id)
    }
}

impl From<&str> for OperationId {
    fn from(id: &str) -> Self {
        OperationId::Uuid(id.to_owned())
    }
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
    operation: Option<OperationId>,
    set: bool,
}

type SendOperation<'a, T> = dyn Fn() -> Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>> + Send + Sync + 'a;

/// A transaction whose callback and returned future are explicitly `Send`.
/// This is the transaction boundary used by generated model writes that may
/// run inside a service callback.
pub struct SendTransaction<'a, T> {
    db: &'a Db,
    f: Box<SendOperation<'a, T>>,
    isolation: Option<Isolation>,
    read_only: bool,
    timeout_ms: u64,
    retry: u32,
    operation: Option<OperationId>,
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
        Transaction { db: self, f, isolation: None, read_only: false, timeout_ms: 0, retry: 3, operation: None, set: false }
    }

    /// Runs a transaction with a callback whose future is required to be
    /// `Send`. The bound is checked at this API boundary, rather than inferred
    /// from an async closure after the transaction has been constructed.
    pub fn transaction_send<'a, F, Fut, T>(&'a self, f: F) -> SendTransaction<'a, T>
    where
        F: Fn() -> Fut + Send + Sync + 'a,
        Fut: Future<Output = Result<T>> + Send + 'a,
        T: Send + 'a,
    {
        SendTransaction {
            db: self,
            f: Box::new(move || Box::pin(f())),
            isolation: None,
            read_only: false,
            timeout_ms: 0,
            retry: 3,
            operation: None,
            set: false,
        }
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
        let tx = Arc::new(begin(self, None, false, None).await.map_err(TransactionOnceError::Orm)?);
        let mut stack = frames();
        stack.push(tx.clone());
        let result = match std::panic::AssertUnwindSafe(FLOW.scope(stack, f())).catch_unwind().await {
            Ok(result) => result,
            Err(payload) => match rollback_and_resume(&tx, payload).await {},
        };
        match result {
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

impl<'a, T> SendTransaction<'a, T> {
    pub fn isolation(mut self, level: Isolation) -> Self {
        self.isolation = Some(level);
        self.set = true;
        self
    }

    pub fn read_only(mut self) -> Self {
        self.read_only = true;
        self.set = true;
        self
    }

    pub fn timeout_ms(mut self, ms: u64) -> Self {
        self.timeout_ms = ms;
        self.set = true;
        self
    }

    pub fn retry(mut self, n: u32) -> Self {
        self.retry = n;
        self
    }

    /// unit of work의 operation id를 정한다. transaction 안의 audit 대상 table insert와
    /// update는 이 값을 operation column에 쓴다.
    pub fn operation(mut self, id: impl Into<OperationId>) -> Self {
        self.operation = Some(id.into());
        self.set = true;
        self
    }
}

impl<'a, T> IntoFuture for SendTransaction<'a, T>
where
    T: Send + 'a,
{
    type Output = Result<T>;
    type IntoFuture = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

    fn into_future(self) -> Self::IntoFuture {
        Box::pin(async move { self.run().await })
    }
}

impl<'a, T> SendTransaction<'a, T>
where
    T: Send + 'a,
{
    async fn run(self) -> Result<T> {
        if let Some(outer) = active_for(self.db) {
            if self.set {
                return Err(Error::Config("a nested transaction of the same connection accepts only the retry option".into()));
            }
            return savepoint_send(outer, self.f.as_ref()).await;
        }
        let mut attempt = 0u32;
        loop {
            let tx = Arc::new(begin(self.db, self.isolation, self.read_only, self.operation.clone()).await?);
            let mut stack = frames();
            stack.push(tx.clone());
            let callback = std::panic::AssertUnwindSafe(FLOW.scope(stack, (self.f)())).catch_unwind();
            let result = if self.timeout_ms == 0 {
                callback.await
            } else {
                match tokio::time::timeout(std::time::Duration::from_millis(self.timeout_ms), callback).await {
                    Ok(result) => result,
                    Err(_) => Ok(Err(Error::Engine { code: codes::CANCELED.into(), msg: "transaction callback timed out".into() })),
                }
            };
            let result = match result {
                Ok(result) => result,
                Err(payload) => match rollback_and_resume(&tx, payload).await {},
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

    /// unit of work의 operation id를 정한다. transaction 안의 audit 대상 table insert와
    /// update는 이 값을 operation column에 쓴다. 바깥 transaction만 정할 수 있다.
    pub fn operation(mut self, id: impl Into<OperationId>) -> Self {
        self.operation = Some(id.into());
        self.set = true;
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
            let tx = Arc::new(begin(self.db, self.isolation, self.read_only, self.operation.clone()).await?);
            let mut stack = frames();
            stack.push(tx.clone());
            let callback = std::panic::AssertUnwindSafe(FLOW.scope(stack, (self.f)())).catch_unwind();
            let result = if self.timeout_ms == 0 {
                callback.await
            } else {
                match tokio::time::timeout(std::time::Duration::from_millis(self.timeout_ms), callback).await {
                    Ok(result) => result,
                    Err(_) => Ok(Err(Error::Engine { code: codes::CANCELED.into(), msg: "transaction callback timed out".into() })),
                }
            };
            let result = match result {
                Ok(result) => result,
                Err(payload) => match rollback_and_resume(&tx, payload).await {},
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

async fn savepoint_send<'a, 'b, T>(tx: Arc<TxShared>, f: &'b SendOperation<'a, T>) -> Result<T>
where
    'a: 'b,
    T: Send + 'a,
{
    let n = tx.savepoints.fetch_add(1, Ordering::AcqRel) + 1;
    let name = format!("orm_sp_{n}");
    let result = async {
        tx.raw(&format!("SAVEPOINT {name}")).await?;
        let mut stack = frames();
        stack.push(tx.clone());
        match FLOW.scope(stack, (f)()).await {
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

async fn begin(db: &Db, isolation: Option<Isolation>, read_only: bool, operation: Option<OperationId>) -> Result<TxShared> {
    if db.inner.closed.load(Ordering::Acquire) {
        return Err(Error::Config("database is closed".into()));
    }
    let level = isolation.map(Isolation::sql);
    let mut sqlite_mode = None;
    let inner = match db.pool() {
        Pool::MySql(p) => {
            let mut conn = CancellableConnection::new(p.acquire().await?);
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
            let mut t = CancellableConnection::new(p.acquire().await?);
            sqlx::raw_sql(sqlx::AssertSqlSafe(statement).into_sql_str()).execute(&mut *t).await?;
            TxInner::Postgres(t)
        }
        Pool::Sqlite(p) => {
            ensure_sqlite_lock_table(db).await?;
            // A write transaction holds the write lock from its start and waits
            // for it up to busy_timeout; a read-only one begins deferred.
            let mut t = CancellableConnection::new(p.acquire().await?);
            sqlx::raw_sql(if read_only { "BEGIN" } else { "BEGIN IMMEDIATE" }).execute(&mut *t).await?;
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
        operation,
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

/// panic한 callback의 transaction을 rollback하고 panic을 이어 간다. rollback이 실패하면
/// panic message가 원인과 실패한 rollback을 함께 담는다(docs/interfaces.md).
async fn rollback_and_resume(tx: &TxShared, payload: Box<dyn std::any::Any + Send>) -> std::convert::Infallible {
    if let Err(rollback_error) = rollback(tx).await {
        let cause = match (payload.downcast_ref::<&str>(), payload.downcast_ref::<String>()) {
            (Some(text), _) => (*text).to_owned(),
            (None, Some(text)) => text.clone(),
            (None, None) => "a panic without a text payload".to_owned(),
        };
        std::panic::resume_unwind(Box::new(Error::Config(format!("transaction failed ({cause}) and rollback failed ({rollback_error})")).to_string()));
    }
    std::panic::resume_unwind(payload)
}

/// Releases named locks, resets session values, and leaves SQLite modes before
/// the transaction ends. 이 상태는 COMMIT과 ROLLBACK 뒤에도 connection에 남으므로
/// 모든 단계를 시도하고 실패를 모두 돌려준다. RELEASE_LOCK 결과가 1이 아니면 이
/// connection이 lock을 갖고 있지 않았다.
async fn finish(tx: &TxShared, inner: &mut TxInner) -> Result<()> {
    let mut errors: Vec<Error> = Vec::new();
    let locks: Vec<String> = std::mem::take(&mut *tx.locks.lock().unwrap());
    if let TxInner::MySql(t) = inner {
        let conn = &mut **t.conn.as_mut().expect("active MySQL transaction connection");
        for key in locks {
            match sqlx::query_scalar::<_, Option<i64>>("SELECT RELEASE_LOCK(?)").bind(&key).fetch_one(&mut *conn).await {
                Ok(Some(1)) => {}
                Ok(_) => errors.push(Error::Config(format!("lock {key} was not held at transaction end"))),
                Err(error) => errors.push(error.into()),
            }
        }
        let keys: Vec<String> = tx.locals.lock().unwrap().keys().cloned().collect();
        for key in keys {
            if let Err(error) = raw_on_conn(conn, &format!("SET @`orm.{key}` = NULL")).await {
                errors.push(error);
            }
        }
    }
    if let TxInner::Sqlite(t) = inner {
        let mode = tx.sqlite_mode.lock().unwrap().take();
        if let Some((uncommitted, read_only)) = mode {
            if read_only {
                if let Err(error) = sqlx::raw_sql("PRAGMA query_only = 0").execute(&mut **t).await {
                    errors.push(error.into());
                }
            }
            if uncommitted {
                if let Err(error) = sqlx::raw_sql("PRAGMA read_uncommitted = 0").execute(&mut **t).await {
                    errors.push(error.into());
                }
            }
        }
    }
    match errors.len() {
        0 => Ok(()),
        1 => Err(errors.remove(0)),
        _ => Err(Error::Config(errors.iter().map(ToString::to_string).collect::<Vec<_>>().join("; "))),
    }
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
    finish(tx, &mut inner).await?;
    match inner {
        TxInner::MySql(t) => t.commit().await?,
        TxInner::Postgres(mut t) => {
            sqlx::raw_sql("COMMIT").execute(&mut *t).await?;
            t.completed();
        }
        TxInner::Sqlite(mut t) => {
            sqlx::raw_sql("COMMIT").execute(&mut *t).await?;
            t.completed();
        }
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
        TxInner::Postgres(mut t) => {
            let result = sqlx::raw_sql("ROLLBACK").execute(&mut *t).await.map(|_| ());
            if result.is_ok() {
                t.completed();
            }
            result
        }
        TxInner::Sqlite(mut t) => {
            let result = sqlx::raw_sql("ROLLBACK").execute(&mut *t).await.map(|_| ());
            if result.is_ok() {
                t.completed();
            }
            result
        }
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
#[path = "tx_send_tests.rs"]
mod send_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(dead_code)]
    fn assert_transaction_send_future<'a, F, Fut, T>(db: &'a Db, f: F)
    where
        F: Fn() -> Fut + Send + Sync + 'a,
        Fut: Future<Output = Result<T>> + Send + 'a,
        T: Send + 'a,
    {
        fn require_send<U: Send>(_: U) {}
        require_send(db.transaction_send(f).into_future());
    }

    #[test]
    fn transaction_send_future_contract_is_checked() {}

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

    /// MySQL transaction을 열고 local 값을 둔 뒤 그 connection을 다른 connection에서 끊는다.
    /// 실제 server는 `SET @`orm.…` = NULL`을 거부하지 않으므로 끊긴 connection으로 reset을 실패시킨다.
    async fn transaction_with_failing_reset(db: &Db) -> TxShared {
        let Pool::MySql(pool) = db.pool() else { panic!("MySQL pool") };
        let tx = begin(db, None, false, None).await.expect("begin");
        let id: u64 = {
            let mut guard = tx.inner.lock().await;
            let Some(TxInner::MySql(t)) = guard.as_mut() else { panic!("MySQL transaction") };
            let conn = &mut **t.conn.as_mut().expect("active MySQL transaction connection");
            sqlx::raw_sql("SET @`orm.ormtest.actor` = 'tester'").execute(&mut *conn).await.expect("set local");
            sqlx::query_scalar("SELECT CONNECTION_ID()").fetch_one(&mut *conn).await.expect("connection id")
        };
        tx.locals.lock().unwrap().insert("ormtest.actor".into(), "tester".into());
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!("KILL {id}"))).execute(pool).await.expect("kill the transaction connection");
        tx
    }

    // transaction 끝의 MySQL RELEASE_LOCK이 lock을 풀지 못하면(결과가 1이 아니면) 그 결과를 보고한다.
    // 풀리지 않은 named lock은 COMMIT과 ROLLBACK 뒤에도 connection에 남는다.
    #[tokio::test]
    async fn lock_not_held_at_transaction_end_is_reported() {
        let db = Db::connect(&required_dsn("ORM_TEST_MYSQL_DSN"), 2, crate::Config::default()).await.expect("connect");
        let key = format!("orm_test.released.{}", std::process::id());
        let result = db
            .transaction(async || {
                db.utils().lock(&key).await?;
                // lock을 미리 풀면 transaction 끝의 RELEASE_LOCK은 0을 돌려준다.
                active_for(&db).expect("transaction active").raw(&format!("DO RELEASE_LOCK('{key}')")).await
            })
            .retry(0)
            .await;
        let error = result.expect_err("a lock released early is reported");
        assert!(error.to_string().contains(&format!("lock {key} was not held at transaction end")), "{error}");
        db.close().await;
    }

    // RELEASE_LOCK이 실패해도 local 값 reset까지 시도하고 두 실패를 모두 보고한다.
    #[tokio::test]
    async fn every_failed_cleanup_step_is_reported() {
        let db = Db::connect(&required_dsn("ORM_TEST_MYSQL_DSN"), 2, crate::Config::default()).await.expect("connect");
        let tx = transaction_with_failing_reset(&db).await;
        tx.locks.lock().unwrap().push(format!("orm_test.killed.{}", std::process::id()));
        let mut inner = tx.inner.lock().await.take().expect("transaction inner");
        let cleanup = finish(&tx, &mut inner).await.expect_err("the cleanup of a killed connection fails");
        drop(inner);
        assert_eq!(cleanup.to_string().split("; ").count(), 2, "the release and the reset are both reported: {cleanup}");
        db.close().await;
    }

    // panic한 callback의 transaction은 connection을 닫아 끝난다. server는 그 session의 transaction과
    // named lock을 끝내므로 다른 connection이 그 lock을 잡는다.
    #[tokio::test]
    async fn panicking_callback_ends_its_transaction() {
        use futures_util::FutureExt as _;
        let db = Db::connect(&required_dsn("ORM_TEST_MYSQL_DSN"), 2, crate::Config::default()).await.expect("connect");
        let key = format!("orm_test.panicked.{}", std::process::id());
        let panicked = std::panic::AssertUnwindSafe(
            db.transaction(async || -> Result<()> {
                db.utils().lock(&key).await?;
                panic!("callback panicked")
            })
            .retry(0)
            .into_future(),
        )
        .catch_unwind()
        .await;
        assert!(panicked.is_err(), "the callback panics");
        let Pool::MySql(pool) = db.pool() else { panic!("MySQL pool") };
        let mut other = pool.acquire().await.expect("another connection");
        // 닫힌 session의 lock이 풀릴 때까지 server가 기다린다.
        let got: Option<i64> = sqlx::query_scalar("SELECT GET_LOCK(?, 5)").bind(&key).fetch_one(&mut *other).await.expect("GET_LOCK");
        assert_eq!(got, Some(1), "the panicked transaction released its lock");
        let released: Option<i64> = sqlx::query_scalar("SELECT RELEASE_LOCK(?)").bind(&key).fetch_one(&mut *other).await.expect("RELEASE_LOCK");
        assert_eq!(released, Some(1));
        drop(other);
        db.close().await;
    }

    /// sqlite_denied가 고른 statement를 SQLite authorizer가 거부한다. 실제 SQLite는 transaction 끝의
    /// ROLLBACK과 PRAGMA를 거부하지 않으므로 이렇게 실패를 만든다.
    static SQLITE_DENIED: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(DENY_NOTHING);
    const DENY_NOTHING: u8 = 0;
    const DENY_ROLLBACK: u8 = 1;
    const DENY_QUERY_ONLY_ON: u8 = 2;
    const DENY_QUERY_ONLY_OFF: u8 = 3;

    unsafe extern "C" fn sqlite_authorizer(
        _: *mut std::ffi::c_void,
        action: std::ffi::c_int,
        first: *const std::ffi::c_char,
        second: *const std::ffi::c_char,
        _: *const std::ffi::c_char,
        _: *const std::ffi::c_char,
    ) -> std::ffi::c_int {
        // SAFETY: SQLite는 null이거나 NUL로 끝나는 문자열을 넘긴다.
        let text = |p: *const std::ffi::c_char| if p.is_null() { "" } else { unsafe { std::ffi::CStr::from_ptr(p) }.to_str().unwrap_or("") };
        let denied = match SQLITE_DENIED.load(Ordering::Acquire) {
            DENY_ROLLBACK => action == libsqlite3_sys::SQLITE_TRANSACTION && text(first) == "ROLLBACK",
            DENY_QUERY_ONLY_ON => action == libsqlite3_sys::SQLITE_PRAGMA && text(first) == "query_only" && text(second) == "1",
            DENY_QUERY_ONLY_OFF => action == libsqlite3_sys::SQLITE_PRAGMA && text(first) == "query_only" && text(second) == "0",
            _ => false,
        };
        if denied {
            libsqlite3_sys::SQLITE_DENY
        } else {
            libsqlite3_sys::SQLITE_OK
        }
    }

    /// pool의 하나뿐인 connection에 authorizer를 두고 denied를 거부하게 한다.
    async fn deny_on_sqlite(db: &Db, denied: u8) {
        let Pool::Sqlite(pool) = db.pool() else { panic!("SQLite pool") };
        let mut conn = pool.acquire().await.expect("SQLite connection");
        let mut handle = conn.lock_handle().await.expect("SQLite handle");
        // SAFETY: handle은 열린 connection이고 authorizer는 'static 함수다.
        let rc = unsafe { libsqlite3_sys::sqlite3_set_authorizer(handle.as_raw_handle().as_ptr(), Some(sqlite_authorizer), std::ptr::null_mut()) };
        assert_eq!(rc, libsqlite3_sys::SQLITE_OK, "sqlite3_set_authorizer");
        SQLITE_DENIED.store(denied, Ordering::Release);
    }

    // native rollback, SQLite mode 복원, begin의 PRAGMA가 실패하면 transaction이 그 오류를 원인과 함께
    // 보고하고, 끝나지 않은 transaction의 connection은 닫혀 다음 transaction이 시작한다.
    #[tokio::test]
    async fn sqlite_transaction_end_failures_are_reported() {
        let tmp = std::env::temp_dir().join(format!("orm-transaction-end-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let db = Db::connect(&format!("sqlite://{}", tmp.join("end.sqlite").display()), 1, crate::Config::default()).await.expect("connect");
        let both = |error: &Error, cause: &str| {
            let text = error.to_string();
            assert!(text.starts_with(&format!("CONFIG: transaction failed ({cause}) and rollback failed (")) && text.contains("not authorized"), "{text}");
        };
        deny_on_sqlite(&db, DENY_ROLLBACK).await;
        let error = db.transaction(async || Err::<(), _>(Error::Config("callback failed".into()))).retry(0).await.expect_err("rollback");
        both(&error, "CONFIG: callback failed");
        deny_on_sqlite(&db, DENY_ROLLBACK).await;
        let panicked =
            std::panic::AssertUnwindSafe(db.transaction(async || -> Result<()> { panic!("callback panicked") }).retry(0).into_future()).catch_unwind().await;
        let payload = panicked.expect_err("the callback panics");
        let text = payload.downcast_ref::<String>().expect("the panic carries the transaction failure");
        assert!(text.starts_with("CONFIG: transaction failed (callback panicked) and rollback failed (") && text.contains("not authorized"), "{text}");
        deny_on_sqlite(&db, DENY_QUERY_ONLY_ON).await;
        let error = db.transaction(async || Ok(())).read_only().retry(0).await.expect_err("begin");
        assert!(error.to_string().contains("not authorized"), "begin: {error}");
        SQLITE_DENIED.store(DENY_NOTHING, Ordering::Release);
        db.transaction(async || Ok(())).retry(0).await.expect("a transaction after the failed begin");
        deny_on_sqlite(&db, DENY_QUERY_ONLY_OFF).await;
        let error = db.transaction(async || Ok(())).read_only().retry(0).await.expect_err("commit");
        assert!(error.to_string().contains("not authorized"), "commit: {error}");
        deny_on_sqlite(&db, DENY_QUERY_ONLY_OFF).await;
        let error = db.transaction(async || Err::<(), _>(Error::Config("callback failed".into()))).read_only().retry(0).await.expect_err("mode reset");
        both(&error, "CONFIG: callback failed");
        SQLITE_DENIED.store(DENY_NOTHING, Ordering::Release);
        db.close().await;
        std::fs::remove_dir_all(tmp).unwrap();
    }

    // transaction 끝의 MySQL local 값 reset이 실패하면 그 오류를 보고한다. MySQL user
    // variable은 COMMIT과 ROLLBACK 뒤에도 남는다(mysql.context.user_variable_session_scope).
    #[tokio::test]
    async fn failed_local_reset_is_reported() {
        let db = Db::connect(&required_dsn("ORM_TEST_MYSQL_DSN"), 2, crate::Config::default()).await.expect("connect");
        let tx = transaction_with_failing_reset(&db).await;
        let mut inner = tx.inner.lock().await.take().expect("transaction inner");
        let reset = finish(&tx, &mut inner).await;
        drop(inner);
        assert!(reset.is_err(), "the reset of a killed connection is reported: {reset:?}");
        let tx = transaction_with_failing_reset(&db).await;
        let ended = rollback(&tx).await.expect_err("the rollback of a killed connection reports the reset");
        assert!(ended.to_string().contains("transaction cleanup failed"), "{ended}");
        db.close().await;
    }
}
