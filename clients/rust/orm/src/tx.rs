//! Callback transactions. Each task keeps a stack of active transactions; a
//! model without a connection runs in the innermost one. A transaction of the
//! same connection inside an active one creates a savepoint.

use std::collections::HashMap;
use std::future::{Future, IntoFuture};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt as _;

use crate::db::{Db, Executor, Pool};
use crate::driver::{CancellableConnection, MySqlOwnedTx, TxInner};
use crate::events::{self, Sent, KIND_BEGIN, KIND_COMMIT, KIND_RELEASE, KIND_ROLLBACK, KIND_ROLLBACK_TO, KIND_SAVEPOINT, KIND_UTILITY};
use crate::schema::Schema;
use crate::value::Param;
use crate::{codes, Error, Result};

/// One active transaction.
pub(crate) struct TxShared {
    pub(crate) db: Db,
    /// 연결에서 이 transaction의 번호다. statement event가 싣는다.
    pub(crate) number: u64,
    pub(crate) inner: tokio::sync::Mutex<Option<TxInner>>,
    pub(crate) finished: AtomicBool,
    savepoints: AtomicU32,
    pub(crate) locals: Mutex<HashMap<String, String>>,
    pub(crate) locks: Mutex<Vec<String>>,
    /// transaction이 시작할 때 삽입한 audit 기록이다. audit 대상 table의 insert와 update가 그 key를 audit
    /// column에 쓴다. audit 값이 없는 transaction이면 None이다.
    pub(crate) audit: Mutex<Option<AuditKey>>,
    sqlite_mode: Mutex<Option<(bool, bool)>>,
}

/// transaction이 시작할 때 삽입한 audit 기록의 table과 primary key 값.
#[derive(Clone, Debug)]
pub(crate) struct AuditKey {
    pub(crate) table: String,
    pub(crate) key: Param,
}

/// transaction의 audit 값: audit 기록 table의 column 이름과 값.
type AuditValues = Vec<(String, Param)>;

/// audit 값을 column 이름과 `Param`으로 모은다.
fn audit_values<K: Into<String>, V: Into<Param>>(values: impl IntoIterator<Item = (K, V)>) -> AuditValues {
    values.into_iter().map(|(k, v)| (k.into(), v.into())).collect()
}

/// transaction이 삽입할 audit 기록: 기록 table을 entity로 가진 등록한 set의 schema, 그 entity, column
/// 이름 순서의 값.
pub(crate) struct AuditInsert {
    pub(crate) schema: &'static Schema,
    pub(crate) entity: orm_schema::dbspec::Entity,
    pub(crate) values: AuditValues,
}

/// audit source의 값에 transaction의 값을 더한 audit 기록이다. 같은 column이면 transaction의 값이 이긴다.
/// 기록 table은 연결에 등록한 set의 audit setting이 references로 이름한 table 하나이며, 그 table을 entity로
/// 가진 set이 연결에 등록되어 있어야 한다. audit source가 없거나, 기록 table이 없거나 여럿이거나, 값의 key가
/// 그 table의 column이 아니거나, primary key가 column 하나가 아니면 CONFIG이고, source의 오류는 그대로
/// 돌려준다. source는 여기서 한 번, transaction을 시작하기 전에 부른다.
fn audit_record(db: &Db, values: &AuditValues) -> Result<AuditInsert> {
    let Some(source) = &db.inner.cfg.audit_source else {
        return Err(Error::Config("the transaction has audit values but the connection has no audit source: set Config::audit_source".into()));
    };
    let schemas: Vec<&'static Schema> = db.inner.schemas.read().unwrap().clone();
    let mut models = Vec::new();
    for schema in schemas {
        models.push((schema, schema.manifest()?));
    }
    let mut tables: Vec<String> = Vec::new();
    for (_, manifest) in &models {
        for audit in manifest.model.entities.iter().filter_map(|e| e.audit.as_ref()) {
            if !tables.contains(&audit.record) {
                tables.push(audit.record.clone());
            }
        }
    }
    tables.sort();
    let target = match tables.as_slice() {
        [] => return Err(Error::Config("the transaction has audit values but no set of the connection has an audited table".into())),
        [table] => models.iter().find_map(|(schema, manifest)| manifest.model.entities.iter().find(|e| &e.table == table).map(|e| (*schema, e.clone()))),
        _ => {
            return Err(Error::Config(format!(
                "the audited tables of the connection record their audits in {}; one audit record table is required",
                tables.join(", ")
            )))
        }
    };
    let Some((schema, entity)) = target else {
        return Err(Error::Config(format!("the audit record table {} is not a table of a set registered on the connection", tables[0])));
    };
    if entity.primary_key.len() != 1 {
        return Err(Error::Config(format!("the audit record table {} needs a primary key of one column", entity.table)));
    }
    let given = source()?;
    let mut merged: Vec<(String, Param)> = Vec::new();
    for set in [&given, values] {
        let mut sorted: Vec<&(String, Param)> = set.iter().collect();
        sorted.sort_by(|a, b| a.0.cmp(&b.0));
        for (column, value) in sorted {
            if entity.field(column).is_none() {
                return Err(Error::Config(format!("audit value {column} is not a column of {}", entity.table)));
            }
            match merged.iter_mut().find(|(c, _)| c == column) {
                Some(slot) => slot.1 = value.clone(),
                None => merged.push((column.clone(), value.clone())),
            }
        }
    }
    merged.sort_by(|a, b| a.0.cmp(&b.0));
    if merged.is_empty() {
        return Err(Error::Config(format!("the audit record of {} has no value: the audit source and the transaction give none", entity.table)));
    }
    Ok(AuditInsert { schema, entity, values: merged })
}

/// transaction의 audit 기록을 transaction 안에서 삽입하고 그 key를 transaction에 둔다. 시도마다 다시
/// 삽입한다.
async fn record_audit(tx: &Arc<TxShared>, record: &AuditInsert) -> Result<()> {
    let key = crate::model::insert_audit(&Executor::Tx(tx.clone()), record).await?;
    *tx.audit.lock().unwrap() = Some(key);
    Ok(())
}

impl TxShared {
    /// transaction의 audit 기록이다. statement를 기다리기 전에 꺼내 쓴다.
    pub(crate) fn audit(&self) -> Option<AuditKey> {
        self.audit.lock().unwrap().clone()
    }

    /// Marks the start of a statement; the transaction rejects concurrent use.
    pub(crate) fn enter(&self) -> Result<tokio::sync::MutexGuard<'_, Option<TxInner>>> {
        if self.finished.load(Ordering::Acquire) {
            return Err(Error::Config("transaction already finished".into()));
        }
        self.inner.try_lock().map_err(|_| Error::Config("the transaction connection is already in use".into()))
    }

    /// Runs a statement text of `kind` on the transaction connection and
    /// publishes its event.
    pub(crate) async fn raw(&self, kind: &str, sql: &str) -> Result<()> {
        let mut guard = self.enter()?;
        let inner = guard.as_mut().ok_or_else(|| Error::Config("transaction already finished".into()))?;
        raw_on(&self.db, inner, Sent::bare(kind, &[], Some(self.number), sql)).await
    }
}

/// transaction 연결에서 bind 없는 statement를 실행하고 그 event를 publish한다.
pub(crate) async fn raw_on(db: &Db, inner: &mut TxInner, s: Sent<'_>) -> Result<()> {
    match inner {
        TxInner::MySql(t) => events::raw(db, &mut **t.conn.as_mut().expect("active MySQL transaction connection"), s).await,
        TxInner::Postgres(t) => events::raw(db, &mut **t, s).await,
        TxInner::Sqlite(t) => events::raw(db, &mut **t, s).await,
    }
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
    audit: Option<AuditValues>,
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
    audit: Option<AuditValues>,
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
                write!(f, "{}: {}", codes::ROLLBACK, crate::rollback_message(callback, rollback))
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
        Transaction { db: self, f, isolation: None, read_only: false, timeout_ms: 0, retry: 3, audit: None, set: false }
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
        SendTransaction { db: self, f: Box::new(move || Box::pin(f())), isolation: None, read_only: false, timeout_ms: 0, retry: 3, audit: None, set: false }
    }

    /// Runs a callback once in a transaction and preserves its own error when
    /// awaited. A nested call uses a savepoint. This call does not retry the
    /// callback. `audit(values)` records the audit of the transaction.
    pub fn transaction_once<F>(&self, f: F) -> TransactionOnce<'_, F> {
        TransactionOnce { db: self, f, audit: None }
    }
}

/// A transaction that runs its callback once: record its audit with `audit`
/// and await it.
pub struct TransactionOnce<'a, F> {
    db: &'a Db,
    f: F,
    audit: Option<AuditValues>,
}

impl<F> TransactionOnce<'_, F> {
    /// Records the audit of the transaction: before the callback the transaction
    /// inserts one audit record with the defaults of the handle (`Db::audit`)
    /// and `values`, and every audited write of the transaction writes its
    /// primary key. A nested call takes no audit.
    pub fn audit<K: Into<String>, V: Into<Param>>(mut self, values: impl IntoIterator<Item = (K, V)>) -> Self {
        self.audit = Some(audit_values(values));
        self
    }
}

impl<'a, F, Fut, T, E> IntoFuture for TransactionOnce<'a, F>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = std::result::Result<T, E>>,
{
    type Output = std::result::Result<T, TransactionOnceError<E>>;
    type IntoFuture = TransactionOnceFuture<'a, F, Fut, T, E>;

    fn into_future(self) -> Self::IntoFuture {
        TransactionOnceFuture { state: OnceState::Start { db: self.db, f: self.f, audit: self.audit } }
    }
}

/// ORM이 내부에서 기다리는 단계(begin, savepoint, commit, rollback)의 future. 이 단계들은 Send이므로
/// `TransactionOnceFuture`는 callback, 그 future, 결과와 오류 type이 Send일 때 Send다.
type OnceStep<'a, R> = Pin<Box<dyn Future<Output = R> + Send + 'a>>;

/// transaction의 task-local frame 안에서 panic을 잡으며 실행하는 callback future.
type OnceCallback<Fut> = futures_util::future::CatchUnwind<std::panic::AssertUnwindSafe<tokio::task::futures::TaskLocalFuture<Vec<Arc<TxShared>>, Fut>>>;

/// callback이 실행되는 곳: 새 transaction이나 바깥 transaction의 savepoint.
enum OnceScope<'a> {
    Transaction { db: &'a Db, tx: Arc<TxShared> },
    Savepoint { tx: Arc<TxShared>, name: String },
}

impl<'a> OnceScope<'a> {
    fn tx(&self) -> &Arc<TxShared> {
        match self {
            OnceScope::Transaction { tx, .. } | OnceScope::Savepoint { tx, .. } => tx,
        }
    }

    /// callback이 성공한 뒤 transaction을 commit하거나 savepoint를 푼다.
    fn close(self) -> OnceStep<'a, Result<()>> {
        match self {
            OnceScope::Transaction { tx, .. } => Box::pin(async move { commit(&tx).await }),
            OnceScope::Savepoint { tx, name, .. } => Box::pin(async move {
                let released = tx.raw(KIND_RELEASE, &format!("RELEASE SAVEPOINT {name}")).await;
                tx.savepoints.fetch_sub(1, Ordering::AcqRel);
                released
            }),
        }
    }

    /// callback이 실패하거나 panic한 뒤 transaction이나 savepoint 뒤의 작업을 되돌린다. transaction의
    /// rollback은 설정된 test fault를 소비한다.
    fn undo(self, fault: bool) -> OnceStep<'a, Result<()>> {
        match self {
            OnceScope::Transaction { db, tx } => Box::pin(async move {
                let rolled_back = rollback(&tx).await;
                if fault {
                    rolled_back.and_then(|()| rollback_fault(db))
                } else {
                    rolled_back
                }
            }),
            OnceScope::Savepoint { tx, name } => Box::pin(async move {
                let undone = rollback_savepoint(&tx, &name).await;
                tx.savepoints.fetch_sub(1, Ordering::AcqRel);
                undone
            }),
        }
    }
}

/// callback의 결과로, scope를 끝낸 뒤 돌려준다.
enum OnceOutcome<T, E> {
    Returned(T),
    Failed(E),
    Panicked(Box<dyn std::any::Any + Send>),
}

enum OnceState<'a, F, Fut, T, E> {
    Start { db: &'a Db, f: F, audit: Option<AuditValues> },
    Opening { f: F, open: OnceStep<'a, Result<OnceScope<'a>>> },
    Running { scope: OnceScope<'a>, callback: Pin<Box<OnceCallback<Fut>>> },
    Ending { outcome: OnceOutcome<T, E>, end: OnceStep<'a, Result<()>> },
    Done,
}

/// The future of a `TransactionOnce`.
pub struct TransactionOnceFuture<'a, F, Fut, T, E> {
    state: OnceState<'a, F, Fut, T, E>,
}

// callback future는 Box 안에서만 pin되고, 다른 field(callback, 결과, 오류)는 pin된 적 없이 옮겨진다.
impl<F, Fut, T, E> Unpin for TransactionOnceFuture<'_, F, Fut, T, E> {}

impl<'a, F, Fut, T, E> Future for TransactionOnceFuture<'a, F, Fut, T, E>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = std::result::Result<T, E>>,
{
    type Output = std::result::Result<T, TransactionOnceError<E>>;

    fn poll(self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Self::Output> {
        use std::task::Poll;
        let this = self.get_mut();
        loop {
            match std::mem::replace(&mut this.state, OnceState::Done) {
                OnceState::Start { db, f, audit } => {
                    let open: OnceStep<'a, Result<OnceScope<'a>>> = match active_for(db) {
                        Some(_) if audit.is_some() => {
                            return Poll::Ready(Err(TransactionOnceError::Orm(Error::Config(
                                "a nested transaction of the same connection takes no audit; it uses the audit of the outer transaction".into(),
                            ))));
                        }
                        Some(tx) => Box::pin(async move {
                            let n = tx.savepoints.fetch_add(1, Ordering::AcqRel) + 1;
                            let name = format!("orm_sp_{n}");
                            match tx.raw(KIND_SAVEPOINT, &format!("SAVEPOINT {name}")).await {
                                Ok(()) => Ok(OnceScope::Savepoint { tx, name }),
                                Err(error) => {
                                    tx.savepoints.fetch_sub(1, Ordering::AcqRel);
                                    Err(error)
                                }
                            }
                        }),
                        None => {
                            let record = match audit.as_ref().map(|values| audit_record(db, values)).transpose() {
                                Ok(record) => record,
                                Err(error) => return Poll::Ready(Err(TransactionOnceError::Orm(error))),
                            };
                            Box::pin(async move {
                                let tx = Arc::new(begin(db, None, false, 0).await?);
                                if let Some(record) = record {
                                    // audit 기록은 callback 전에 transaction frame 안에서 삽입한다. 실패하면
                                    // transaction을 되돌리고 그 오류를 돌려준다.
                                    let mut stack = frames();
                                    stack.push(tx.clone());
                                    if let Err(error) = FLOW.scope(stack, record_audit(&tx, &record)).await {
                                        return Err(match rollback(&tx).await.and_then(|()| rollback_fault(db)) {
                                            Ok(()) => error,
                                            Err(rollback) => Error::rollback(error, rollback),
                                        });
                                    }
                                }
                                Ok(OnceScope::Transaction { db, tx })
                            })
                        }
                    };
                    this.state = OnceState::Opening { f, open };
                }
                OnceState::Opening { f, mut open } => match open.as_mut().poll(cx) {
                    Poll::Pending => {
                        this.state = OnceState::Opening { f, open };
                        return Poll::Pending;
                    }
                    Poll::Ready(Err(error)) => return Poll::Ready(Err(TransactionOnceError::Orm(error))),
                    Poll::Ready(Ok(scope)) => {
                        let mut stack = frames();
                        stack.push(scope.tx().clone());
                        let callback = Box::pin(std::panic::AssertUnwindSafe(FLOW.scope(stack, f())).catch_unwind());
                        this.state = OnceState::Running { scope, callback };
                    }
                },
                OnceState::Running { scope, mut callback } => match callback.as_mut().poll(cx) {
                    Poll::Pending => {
                        this.state = OnceState::Running { scope, callback };
                        return Poll::Pending;
                    }
                    Poll::Ready(Ok(Ok(value))) => this.state = OnceState::Ending { outcome: OnceOutcome::Returned(value), end: scope.close() },
                    Poll::Ready(Ok(Err(error))) => this.state = OnceState::Ending { outcome: OnceOutcome::Failed(error), end: scope.undo(true) },
                    Poll::Ready(Err(payload)) => this.state = OnceState::Ending { outcome: OnceOutcome::Panicked(payload), end: scope.undo(false) },
                },
                OnceState::Ending { outcome, mut end } => {
                    let ended = match end.as_mut().poll(cx) {
                        Poll::Pending => {
                            this.state = OnceState::Ending { outcome, end };
                            return Poll::Pending;
                        }
                        Poll::Ready(ended) => ended,
                    };
                    return Poll::Ready(match (outcome, ended) {
                        (OnceOutcome::Returned(value), Ok(())) => Ok(value),
                        (OnceOutcome::Returned(_), Err(error)) => Err(TransactionOnceError::Orm(error)),
                        (OnceOutcome::Failed(callback), Ok(())) => Err(TransactionOnceError::Callback(callback)),
                        (OnceOutcome::Failed(callback), Err(rollback)) => Err(TransactionOnceError::Rollback { callback, rollback }),
                        (OnceOutcome::Panicked(payload), ended) => resume_panic(payload, ended.err()),
                    });
                }
                OnceState::Done => panic!("TransactionOnceFuture polled after completion"),
            }
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

    /// Bounds every statement of the transaction; see `Transaction::timeout_ms`.
    pub fn timeout_ms(mut self, ms: u64) -> Self {
        self.timeout_ms = ms;
        self.set = true;
        self
    }

    pub fn retry(mut self, n: u32) -> Self {
        self.retry = n;
        self
    }

    /// Records the audit of the transaction with the defaults of the handle
    /// (`Db::audit`) and `values`; see `Transaction::audit`.
    pub fn audit<K: Into<String>, V: Into<Param>>(mut self, values: impl IntoIterator<Item = (K, V)>) -> Self {
        self.audit = Some(audit_values(values));
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
        let record = self.audit.as_ref().map(|values| audit_record(self.db, values)).transpose()?;
        let mut attempt = 0u32;
        loop {
            let tx = Arc::new(begin(self.db, self.isolation, self.read_only, self.timeout_ms).await?);
            let mut stack = frames();
            stack.push(tx.clone());
            let body = async {
                if let Some(record) = &record {
                    record_audit(&tx, record).await?;
                }
                (self.f)().await
            };
            let callback = std::panic::AssertUnwindSafe(FLOW.scope(stack, body)).catch_unwind();
            let result = match callback.await {
                Ok(result) => result,
                Err(payload) => match rollback_and_resume(&tx, payload).await {},
            };
            match result {
                Ok(v) => {
                    commit(&tx).await?;
                    return Ok(v);
                }
                Err(e) => {
                    if let Err(rollback_error) = rollback(&tx).await.and_then(|()| rollback_fault(self.db)) {
                        return Err(Error::rollback(e, rollback_error));
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

    /// Bounds every statement of the transaction in milliseconds: PostgreSQL
    /// sends `SET LOCAL statement_timeout = <ms>` after its `BEGIN`, and the
    /// server cancels a statement that runs longer with `CANCELED`. MySQL and
    /// SQLite fail with `CAPABILITY_UNSUPPORTED` before the transaction
    /// begins. Zero sets no bound.
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

    /// Makes the transaction one unit of work with an audit record. Before the
    /// callback, in every attempt, the transaction inserts one row into the
    /// audit record table: the defaults of the handle (`Db::audit`) with
    /// `values`, of which a value wins over the default of the same column.
    /// Every insert, update, soft delete and restore of an audited table in the
    /// transaction writes the record's primary key into the table's audit
    /// column. The handle must have defaults, and every key must be a column of
    /// the audit record table; otherwise the transaction fails with CONFIG
    /// before it begins. A nested transaction uses the audit of the outer one
    /// and takes none.
    pub fn audit<K: Into<String>, V: Into<Param>>(mut self, values: impl IntoIterator<Item = (K, V)>) -> Self {
        self.audit = Some(audit_values(values));
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
        let record = self.audit.as_ref().map(|values| audit_record(self.db, values)).transpose()?;
        let mut attempt = 0u32;
        loop {
            let tx = Arc::new(begin(self.db, self.isolation, self.read_only, self.timeout_ms).await?);
            let mut stack = frames();
            stack.push(tx.clone());
            let body = async {
                if let Some(record) = &record {
                    record_audit(&tx, record).await?;
                }
                (self.f)().await
            };
            let callback = std::panic::AssertUnwindSafe(FLOW.scope(stack, body)).catch_unwind();
            let result = match callback.await {
                Ok(result) => result,
                Err(payload) => match rollback_and_resume(&tx, payload).await {},
            };
            match result {
                Ok(v) => {
                    commit(&tx).await?;
                    return Ok(v);
                }
                Err(e) => {
                    if let Err(rollback_error) = rollback(&tx).await.and_then(|()| rollback_fault(self.db)) {
                        return Err(Error::rollback(e, rollback_error));
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
    match run_savepoint(tx, f()).await? {
        Ok(value) => Ok(value),
        Err((callback, None)) => Err(callback),
        Err((callback, Some(rollback))) => Err(Error::rollback(callback, rollback)),
    }
}

async fn savepoint_send<'a, 'b, T>(tx: Arc<TxShared>, f: &'b SendOperation<'a, T>) -> Result<T>
where
    'a: 'b,
    T: Send + 'a,
{
    match run_savepoint(tx, (f)()).await? {
        Ok(value) => Ok(value),
        Err((callback, None)) => Err(callback),
        Err((callback, Some(rollback))) => Err(Error::rollback(callback, rollback)),
    }
}

/// savepoint를 끝낸 callback의 결과다.
enum SavepointEnd<T, E> {
    Returned(std::result::Result<T, (E, Option<Error>)>),
    Panicked(Box<dyn std::any::Any + Send>, Option<Error>),
}

/// savepoint 안에서 callback을 실행한다. 성공한 callback은 savepoint를 풀고, 실패하거나 panic한
/// callback은 savepoint 뒤의 작업을 되돌리고 savepoint를 푼다. callback 오류는 끝내지 못한 savepoint의
/// 오류와 함께 돌려주고, panic은 그 오류가 있으면 transaction과 같은 형식의 오류로 이어 간다.
async fn run_savepoint<T, E, Fut>(tx: Arc<TxShared>, callback: Fut) -> Result<std::result::Result<T, (E, Option<Error>)>>
where
    Fut: Future<Output = std::result::Result<T, E>>,
{
    let n = tx.savepoints.fetch_add(1, Ordering::AcqRel) + 1;
    let name = format!("orm_sp_{n}");
    let ended = async {
        tx.raw(KIND_SAVEPOINT, &format!("SAVEPOINT {name}")).await?;
        let mut stack = frames();
        stack.push(tx.clone());
        Ok::<_, Error>(match std::panic::AssertUnwindSafe(FLOW.scope(stack, callback)).catch_unwind().await {
            Ok(Ok(value)) => {
                tx.raw(KIND_RELEASE, &format!("RELEASE SAVEPOINT {name}")).await?;
                SavepointEnd::Returned(Ok(value))
            }
            Ok(Err(error)) => SavepointEnd::Returned(Err((error, rollback_savepoint(&tx, &name).await.err()))),
            Err(payload) => SavepointEnd::Panicked(payload, rollback_savepoint(&tx, &name).await.err()),
        })
    }
    .await;
    tx.savepoints.fetch_sub(1, Ordering::AcqRel);
    match ended? {
        SavepointEnd::Returned(result) => Ok(result),
        SavepointEnd::Panicked(payload, rollback) => resume_panic(payload, rollback),
    }
}

/// savepoint 뒤의 작업을 되돌리고 savepoint를 푼다. 두 statement를 모두 시도하고 실패를 모두 돌려준다.
async fn rollback_savepoint(tx: &TxShared, name: &str) -> Result<()> {
    let rolled_back = tx.raw(KIND_ROLLBACK_TO, &format!("ROLLBACK TO SAVEPOINT {name}")).await;
    let released = tx.raw(KIND_RELEASE, &format!("RELEASE SAVEPOINT {name}")).await;
    joined([rolled_back.err(), released.err()].into_iter().flatten().collect())
}

/// 오류가 없으면 Ok, 하나면 그 오류, 여럿이면 message를 모은 CONFIG다.
fn joined(mut errors: Vec<Error>) -> Result<()> {
    match errors.len() {
        0 => Ok(()),
        1 => Err(errors.remove(0)),
        _ => Err(Error::Config(errors.iter().map(ToString::to_string).collect::<Vec<_>>().join("; "))),
    }
}

async fn begin(db: &Db, isolation: Option<Isolation>, read_only: bool, timeout_ms: u64) -> Result<TxShared> {
    if db.inner.closed.load(Ordering::Acquire) {
        return Err(Error::Config("database is closed".into()));
    }
    if timeout_ms > 0 && !matches!(db.pool(), Pool::Postgres(_)) {
        return Err(Error::Engine { code: codes::CAPABILITY_UNSUPPORTED.into(), msg: "transaction timeoutMs is supported only by postgres".into() });
    }
    let level = isolation.map(Isolation::sql);
    // transaction을 여는 statement다(docs/usage.md "Statement events").
    let mut opening: Vec<(&str, String)> = Vec::new();
    let mut sqlite_mode = None;
    let inner = match db.pool() {
        Pool::MySql(p) => {
            if let Some(level) = level {
                opening.push((KIND_UTILITY, format!("SET TRANSACTION ISOLATION LEVEL {level}")));
            }
            opening.push((KIND_BEGIN, if read_only { "START TRANSACTION READ ONLY" } else { "START TRANSACTION" }.into()));
            TxInner::MySql(MySqlOwnedTx { conn: Some(CancellableConnection::new(p.acquire().await?)) })
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
            opening.push((KIND_BEGIN, statement));
            if timeout_ms > 0 {
                opening.push((KIND_UTILITY, format!("SET LOCAL statement_timeout = {timeout_ms}")));
            }
            TxInner::Postgres(CancellableConnection::new(p.acquire().await?))
        }
        Pool::Sqlite(p) => {
            // SQLite의 row lock table은 연결의 첫 transaction 전에 한 번 만든다.
            ensure_sqlite_lock_table(db).await?;
            // A write transaction holds the write lock from its start and waits
            // for it up to busy_timeout; a read-only one begins deferred.
            opening.push((KIND_BEGIN, if read_only { "BEGIN" } else { "BEGIN IMMEDIATE" }.into()));
            let uncommitted = isolation == Some(Isolation::ReadUncommitted);
            if uncommitted {
                opening.push((KIND_UTILITY, "PRAGMA read_uncommitted = 1".into()));
            }
            if read_only {
                opening.push((KIND_UTILITY, "PRAGMA query_only = 1".into()));
            }
            if uncommitted || read_only {
                sqlite_mode = Some((uncommitted, read_only));
            }
            TxInner::Sqlite(CancellableConnection::new(p.acquire().await?))
        }
    };
    let tx = TxShared {
        db: db.clone(),
        number: db.next_transaction(),
        inner: tokio::sync::Mutex::new(Some(inner)),
        finished: AtomicBool::new(false),
        savepoints: AtomicU32::new(0),
        locals: Mutex::new(HashMap::new()),
        locks: Mutex::new(Vec::new()),
        audit: Mutex::new(None),
        sqlite_mode: Mutex::new(sqlite_mode),
    };
    let mut began = false;
    for (kind, sql) in &opening {
        if let Err(error) = tx.raw(kind, sql).await {
            if began {
                // 열린 transaction은 되돌린다. 되돌리지 못한 연결은 닫는다.
                return Err(match rollback(&tx).await {
                    Ok(()) => error,
                    Err(rollback) => Error::rollback(error, rollback),
                });
            }
            // 열기 전에 실패한 연결은 session에 남은 설정이 다음 사용자에게 가지 않도록 닫는다.
            tx.finished.store(true, Ordering::Release);
            return Err(error);
        }
        began |= *kind == KIND_BEGIN;
    }
    Ok(tx)
}

/// SQLite row lock이 쓰는 table이다.
pub(crate) const ROW_LOCK_TABLE: &str = "orm__row_lock";

async fn ensure_sqlite_lock_table(db: &Db) -> Result<()> {
    if db.inner.sqlite_lock_ready.load(Ordering::Acquire) {
        return Ok(());
    }
    if let Pool::Sqlite(p) = db.pool() {
        let tables = [ROW_LOCK_TABLE.to_owned()];
        let create = "CREATE TABLE IF NOT EXISTS \"orm__row_lock\" (\"id\" INTEGER PRIMARY KEY CHECK (\"id\" = 1))";
        events::raw(db, p, Sent::bare(KIND_UTILITY, &tables, None, create)).await?;
        db.inner.sqlite_lock_ready.store(true, Ordering::Release);
    }
    Ok(())
}

/// panic한 callback의 transaction을 rollback하고 panic을 이어 간다. rollback이 실패하면
/// panic message가 원인과 실패한 rollback을 함께 담는다(docs/interfaces.md).
async fn rollback_and_resume(tx: &TxShared, payload: Box<dyn std::any::Any + Send>) -> std::convert::Infallible {
    resume_panic(payload, rollback(tx).await.err())
}

/// panic을 이어 간다. transaction이나 savepoint를 끝내지 못했으면 panic 값은 원인과 그 오류를 담은
/// ROLLBACK 오류의 text다.
fn resume_panic(payload: Box<dyn std::any::Any + Send>, rollback: Option<Error>) -> ! {
    if let Some(rollback) = rollback {
        let cause = match (payload.downcast_ref::<&str>(), payload.downcast_ref::<String>()) {
            (Some(text), _) => (*text).to_owned(),
            (None, Some(text)) => text.clone(),
            (None, None) => "a panic without a text payload".to_owned(),
        };
        std::panic::resume_unwind(Box::new(format!("{}: {}", codes::ROLLBACK, crate::rollback_message(&cause, &rollback))));
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
    let db = &tx.db;
    let number = Some(tx.number);
    if let TxInner::MySql(t) = inner {
        let conn = &mut **t.conn.as_mut().expect("active MySQL transaction connection");
        for key in locks {
            let release = "SELECT RELEASE_LOCK(?)";
            let binds = [Param::Str(key.clone())];
            let start = std::time::Instant::now();
            let r = sqlx::query_scalar::<_, Option<i64>>(release).bind(&key).fetch_one(&mut *conn).await.map_err(Error::from);
            match db.statement_done(Sent { sql: release, binds: &binds, kind: KIND_UTILITY, tables: &[], transaction: number }, start, r) {
                Ok(Some(1)) => {}
                Ok(_) => errors.push(Error::Config(format!("lock {key} was not held at transaction end"))),
                Err(error) => errors.push(error),
            }
        }
        // 값을 지우는 statement는 key 순서로 실행한다.
        let mut keys: Vec<String> = tx.locals.lock().unwrap().keys().cloned().collect();
        keys.sort();
        for key in keys {
            let clear = format!("SET @`orm.{key}` = NULL");
            if let Err(error) = events::raw(db, &mut *conn, Sent::bare(KIND_UTILITY, &[], number, &clear)).await {
                errors.push(error);
            }
        }
    }
    if let TxInner::Sqlite(t) = inner {
        let mode = tx.sqlite_mode.lock().unwrap().take();
        if let Some((uncommitted, read_only)) = mode {
            if read_only {
                if let Err(error) = events::raw(db, &mut **t, Sent::bare(KIND_UTILITY, &[], number, "PRAGMA query_only = 0")).await {
                    errors.push(error);
                }
            }
            if uncommitted {
                if let Err(error) = events::raw(db, &mut **t, Sent::bare(KIND_UTILITY, &[], number, "PRAGMA read_uncommitted = 0")).await {
                    errors.push(error);
                }
            }
        }
    }
    joined(errors)
}

/// transaction을 끝내는 statement(COMMIT이나 ROLLBACK)를 실행한다. 성공하고 `clean`이면 연결을 pool에
/// 돌려주고, 실패하거나 앞의 정리가 실패했으면(`clean`이 아니면) 상태를 알 수 없는 연결을 닫는다. pool에
/// 돌아가는 연결은 깨끗하거나 버려진다.
async fn end(tx: &TxShared, inner: TxInner, kind: &str, sql: &str, clean: bool) -> Result<()> {
    let s = Sent::bare(kind, &[], Some(tx.number), sql);
    match inner {
        TxInner::MySql(mut t) => {
            let mut conn = t.conn.take().expect("active MySQL transaction connection");
            events::raw(&tx.db, &mut *conn, s).await?;
            if clean {
                conn.completed();
            }
        }
        TxInner::Postgres(mut t) => {
            events::raw(&tx.db, &mut *t, s).await?;
            if clean {
                t.completed();
            }
        }
        TxInner::Sqlite(mut t) => {
            events::raw(&tx.db, &mut *t, s).await?;
            if clean {
                t.completed();
            }
        }
    }
    Ok(())
}

async fn commit(tx: &TxShared) -> Result<()> {
    tx.finished.store(true, Ordering::Release);
    let mut guard = tx.inner.lock().await;
    let Some(mut inner) = guard.take() else {
        return Err(Error::Config("transaction already finished".into()));
    };
    finish(tx, &mut inner).await?;
    end(tx, inner, KIND_COMMIT, "COMMIT", true).await
}

/// transaction이 rollback된 뒤 설정된 test fault를 소비한다: 그 rollback은
/// `FAULT`로 실패했다고 보고된다 (`orm::testing::fail_next_rollback`, feature
/// `test-faults`).
fn rollback_fault(db: &Db) -> Result<()> {
    if db.inner.rollback_fault.swap(false, Ordering::AcqRel) {
        return Err(Error::Engine { code: codes::FAULT.into(), msg: "test fault: the rollback of the transaction ran and is reported as failed".into() });
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
    let rolled_back = end(tx, inner, KIND_ROLLBACK, "ROLLBACK", cleanup.is_ok()).await;
    match (cleanup, rolled_back) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(e), Ok(())) => Err(e),
        (Ok(()), Err(e)) => Err(e),
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
    fn transaction_send_future_contract_is_checked() {
        let _case = orm_testcase::case!(orm_testcase::DATABASE);
    }

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
        let _case = orm_testcase::case!(orm_testcase::DATABASE);
        let error = TransactionOnceError::Rollback { callback: DomainFailure::Rejected, rollback: Error::Config("rollback rejected".into()) };
        assert!(error.to_string().contains("request rejected"));
        assert!(error.to_string().contains("rollback rejected"));
        assert_eq!(std::error::Error::source(&error).unwrap().to_string(), "request rejected");
    }

    #[tokio::test]
    async fn one_shot_transaction_preserves_callback_error_and_rolls_back() {
        let _case = orm_testcase::case!(orm_testcase::DATABASE);
        let tmp = std::env::temp_dir().join(format!("orm-once-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        // probe table은 공유 test database가 아니라 case 자신의 database에 둔다. 다른 실행이 같은
        // 이름의 table을 지우거나 panic한 실행이 남긴 table이 이 case를 흔들지 않는다.
        let mysql = orm_case_database::CaseDatabase::create("mysql").await;
        let postgres = orm_case_database::CaseDatabase::create("postgres").await;
        let targets =
            [("sqlite", format!("sqlite://{}", tmp.join("once.sqlite").display())), ("mysql", mysql.dsn().to_owned()), ("postgres", postgres.dsn().to_owned())];
        for (driver, dsn) in targets {
            let db = Db::connect(&dsn, 2, crate::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
            execute(&db, "DROP TABLE IF EXISTS orm_once_probe").await;
            execute(&db, "CREATE TABLE orm_once_probe (id INTEGER PRIMARY KEY)").await;
            let result = db
                .transaction_once(async || {
                    active_for(&db).expect("transaction active").raw(KIND_UTILITY, "INSERT INTO orm_once_probe (id) VALUES (1)").await.unwrap();
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
                active_for(&db).expect("transaction active").raw(KIND_UTILITY, "INSERT INTO orm_once_probe (id) VALUES (2)").await.unwrap();
                Ok::<_, DomainFailure>(())
            })
            .await
            .unwrap_or_else(|e| panic!("{driver}: commit: {e:?}"));
            db.transaction(async || {
                active_for(&db).expect("transaction active").raw(KIND_UTILITY, "INSERT INTO orm_once_probe (id) VALUES (3)").await?;
                let nested = db
                    .transaction_once(async || {
                        active_for(&db).expect("transaction active").raw(KIND_UTILITY, "INSERT INTO orm_once_probe (id) VALUES (4)").await.unwrap();
                        Err::<(), _>(DomainFailure::Rejected)
                    })
                    .await;
                assert!(matches!(nested, Err(TransactionOnceError::Callback(DomainFailure::Rejected))), "{driver}: {nested:?}");
                active_for(&db).expect("transaction active").raw(KIND_UTILITY, "INSERT INTO orm_once_probe (id) VALUES (5)").await
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
        mysql.drop().await;
        postgres.drop().await;
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

    /// `timeout_ms`는 PostgreSQL에서 `SET LOCAL statement_timeout`이므로 server가 오래 걸리는 statement를
    /// 끝내고 transaction은 rollback된다. MySQL과 SQLite는 그 option을 지원하지 않으므로 transaction은
    /// 시작하기 전에 CAPABILITY_UNSUPPORTED로 실패하고 callback은 실행되지 않는다(docs/interfaces.md).
    /// 0은 option을 주지 않은 것과 같다. 각 database의 어긋남을 모아 마지막에 함께 보고한다.
    #[tokio::test]
    async fn transaction_timeout_is_the_postgres_statement_timeout() {
        let _case = orm_testcase::case!(orm_testcase::DATABASE);
        let tmp = std::env::temp_dir().join(format!("orm-timeout-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        // probe table은 case 자신의 database에 둔다(one_shot_transaction_preserves_callback_error_and_rolls_back과 같다).
        let mysql = orm_case_database::CaseDatabase::create("mysql").await;
        let postgres = orm_case_database::CaseDatabase::create("postgres").await;
        let targets = [
            ("sqlite", format!("sqlite://{}", tmp.join("timeout.sqlite").display())),
            ("mysql", mysql.dsn().to_owned()),
            ("postgres", postgres.dsn().to_owned()),
        ];
        let mut mismatches = Vec::new();
        for (driver, dsn) in targets {
            let db = Db::connect(&dsn, 2, crate::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
            execute(&db, "DROP TABLE IF EXISTS orm_timeout_probe").await;
            execute(&db, "CREATE TABLE orm_timeout_probe (id INTEGER PRIMARY KEY)").await;
            let ran = std::cell::Cell::new(false);
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                db.transaction(async || {
                    ran.set(true);
                    let tx = active_for(&db).expect("transaction is active");
                    tx.raw(KIND_UTILITY, "INSERT INTO orm_timeout_probe (id) VALUES (1)").await?;
                    match driver {
                        "mysql" => tx.raw(KIND_UTILITY, "SELECT SLEEP(0.2)").await?,
                        "postgres" => tx.raw(KIND_UTILITY, "SELECT pg_sleep(0.2)").await?,
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
            let got = match &result {
                Ok(()) => "ok".to_owned(),
                Err(error) => error.to_string(),
            };
            let (want, want_ran) = if driver == "postgres" {
                ("CANCELED: canceling statement due to statement timeout (SQLSTATE 57014)", true)
            } else {
                ("CAPABILITY_UNSUPPORTED: transaction timeoutMs is supported only by postgres", false)
            };
            if got != want || ran.get() != want_ran {
                mismatches.push(format!("{driver}: got {got:?} with callback run {}, want {want:?} with callback run {want_ran}", ran.get()));
            }
            assert_eq!(count(&db).await, 0, "{driver}: nothing committed");
            db.transaction(async || {
                active_for(&db).expect("transaction is active").raw(KIND_UTILITY, "INSERT INTO orm_timeout_probe (id) VALUES (2)").await?;
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                Ok(())
            })
            .timeout_ms(0)
            .retry(0)
            .await
            .unwrap_or_else(|e| panic!("{driver}: zero timeout: {e}"));
            assert_eq!(count(&db).await, 1, "{driver}: zero sets no timeout");
            execute(&db, "DROP TABLE orm_timeout_probe").await;
            db.close().await;
        }
        mysql.drop().await;
        postgres.drop().await;
        std::fs::remove_dir_all(tmp).unwrap();
        assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
    }

    /// MySQL transaction을 열고 local 값을 둔 뒤 그 connection을 다른 connection에서 끊는다.
    /// 실제 server는 `SET @`orm.…` = NULL`을 거부하지 않으므로 끊긴 connection으로 reset을 실패시킨다.
    /// server session을 끊는 test이므로 db는 pooler가 아니라 ORM_TEST_MYSQL_SERVER_DSN의 server에
    /// 연결한다. ProxySQL은 KILL을 자기 client session의 명령으로 받는다.
    async fn transaction_with_failing_reset(db: &Db) -> TxShared {
        let Pool::MySql(pool) = db.pool() else { panic!("MySQL pool") };
        let tx = begin(db, None, false, 0).await.expect("begin");
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
        let _case = orm_testcase::case!(orm_testcase::DATABASE);
        let db = Db::connect(&required_dsn("ORM_TEST_MYSQL_DSN"), 2, crate::Config::default()).await.expect("connect");
        let key = format!("orm_test.released.{}", std::process::id());
        let result = db
            .transaction(async || {
                db.utils().lock(&key).await?;
                // lock을 미리 풀면 transaction 끝의 RELEASE_LOCK은 0을 돌려준다.
                active_for(&db).expect("transaction active").raw(KIND_UTILITY, &format!("DO RELEASE_LOCK('{key}')")).await
            })
            .retry(0)
            .await;
        let error = result.expect_err("a lock released early is reported");
        assert!(error.to_string().contains(&format!("lock {key} was not held at transaction end")), "{error}");
        db.close().await;
    }

    // transaction 끝의 정리가 실패한 connection은 pool에 돌아가지 않고 닫힌다. 실패한 정리 뒤 session의
    // 상태는 알 수 없으므로 pool에 돌아가는 connection은 깨끗하거나 버려진다. connection이 하나인 pool의
    // 다음 사용이 같은 session(CONNECTION_ID)을 받으면 connection이 돌아간 것이다. commit은 실패한 정리 뒤
    // connection을 닫고, rollback도 그래야 한다. 깨끗하게 끝난 transaction은 같은 session을 다시 쓴다.
    // session을 보는 test이므로 pooler가 아니라 ORM_TEST_MYSQL_SERVER_DSN의 server에 연결한다.
    #[tokio::test]
    async fn failed_cleanup_discards_the_connection() {
        let _case = orm_testcase::case!(orm_testcase::DATABASE);
        let db = Db::connect(&required_dsn("ORM_TEST_MYSQL_SERVER_DSN"), 1, crate::Config::default()).await.expect("connect");
        let Pool::MySql(pool) = db.pool() else { panic!("MySQL pool") };
        let session = || async {
            let mut conn = pool.acquire().await.expect("pool connection");
            let id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()").fetch_one(&mut *conn).await.expect("connection id");
            id
        };
        let clean = session().await;
        db.transaction(async || db.utils().lock(&format!("orm_test.clean.{}", std::process::id())).await).retry(0).await.expect("a clean transaction");
        assert_eq!(session().await, clean, "a transaction that ended cleanly keeps its session");
        for fail in [true, false] {
            let before = session().await;
            let key = format!("orm_test.discard.{fail}.{}", std::process::id());
            let result = db
                .transaction(async || {
                    db.utils().lock(&key).await?;
                    // lock을 미리 풀면 transaction 끝의 RELEASE_LOCK은 0을 돌려주어 정리가 실패한다.
                    active_for(&db).expect("transaction active").raw(KIND_UTILITY, &format!("DO RELEASE_LOCK('{key}')")).await?;
                    if fail {
                        return Err(Error::Config("callback failed".into()));
                    }
                    Ok(())
                })
                .retry(0)
                .await;
            assert!(result.is_err(), "the failed cleanup is reported");
            let path = if fail { "rollback" } else { "commit" };
            assert_ne!(session().await, before, "{path}: session {before} returned to the pool after its cleanup failed");
        }
        db.close().await;
    }

    // RELEASE_LOCK이 실패해도 local 값 reset까지 시도하고 두 실패를 모두 보고한다.
    #[tokio::test]
    async fn every_failed_cleanup_step_is_reported() {
        let _case = orm_testcase::case!(orm_testcase::DATABASE);
        let db = Db::connect(&required_dsn("ORM_TEST_MYSQL_SERVER_DSN"), 2, crate::Config::default()).await.expect("connect");
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
        let _case = orm_testcase::case!(orm_testcase::DATABASE);
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

    // 끝나지 않은 채 drop된 transaction future는 connection을 닫는다. server는 그 session의
    // transaction과 lock을 끝내므로 다른 connection이 그 lock을 잡는다. MySQL test server의
    // connection은 TLS로 연결되며, sqlx의 TLS stream shutdown은 server가 보내지 않는 data를 기다린다.
    // server session의 끝을 보는 test이므로 pooler가 아니라 ORM_TEST_MYSQL_SERVER_DSN과
    // ORM_TEST_POSTGRES_SERVER_DSN의 server에 연결한다.
    // SQLite에서는 닫힌 connection의 write transaction이 끝나 다른 connection이 write lock을 잡는다.
    #[tokio::test]
    async fn dropped_transaction_closes_its_connection() {
        let _case = orm_testcase::case!(orm_testcase::DATABASE);
        let tmp = std::env::temp_dir().join(format!("orm-dropped-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let targets = [
            ("sqlite", format!("sqlite://{}", tmp.join("dropped.sqlite").display())),
            ("mysql", required_dsn("ORM_TEST_MYSQL_SERVER_DSN")),
            ("postgres", required_dsn("ORM_TEST_POSTGRES_SERVER_DSN")),
        ];
        for (driver, dsn) in targets {
            let db = Db::connect(&dsn, 2, crate::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
            match db.pool() {
                Pool::MySql(pool) => {
                    let cipher: (String, String) = sqlx::query_as("SHOW SESSION STATUS LIKE 'Ssl_cipher'").fetch_one(pool).await.expect("Ssl_cipher");
                    assert!(!cipher.1.is_empty(), "the MySQL test connection uses TLS");
                }
                Pool::Sqlite(_) => execute(&db, "CREATE TABLE orm_dropped_probe (id INTEGER PRIMARY KEY)").await,
                Pool::Postgres(_) => {}
            }
            let key = format!("orm_test.dropped.{}", std::process::id());
            let held = Arc::new(tokio::sync::Notify::new());
            let transaction = db
                .transaction(async || -> Result<()> {
                    db.utils().lock(&key).await?;
                    if driver == "sqlite" {
                        active_for(&db).expect("transaction active").raw(KIND_UTILITY, "INSERT INTO orm_dropped_probe (id) VALUES (1)").await?;
                    }
                    held.notify_one();
                    std::future::pending::<()>().await;
                    Ok(())
                })
                .retry(0)
                .into_future();
            tokio::select! {
                result = transaction => panic!("{driver}: the transaction ended before the drop: {result:?}"),
                _ = held.notified() => {}
            }
            // 닫힌 session의 lock이 풀릴 때까지 server가 5초까지 기다린다.
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
            }
            db.close().await;
        }
        std::fs::remove_dir_all(tmp).unwrap();
    }

    /// sqlite_denied가 고른 statement를 SQLite authorizer가 거부한다. 실제 SQLite는 transaction 끝의
    /// ROLLBACK과 PRAGMA를 거부하지 않으므로 이렇게 실패를 만든다.
    static SQLITE_DENIED: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(DENY_NOTHING);
    /// SQLITE_DENIED는 process에 하나이므로 그것을 쓰는 test는 이 lock을 잡고 하나씩 실행한다.
    static SQLITE_DENIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    const DENY_NOTHING: u8 = 0;
    const DENY_ROLLBACK: u8 = 1;
    const DENY_QUERY_ONLY_ON: u8 = 2;
    const DENY_QUERY_ONLY_OFF: u8 = 3;
    const DENY_SAVEPOINT_ROLLBACK: u8 = 4;
    const DENY_SAVEPOINT_RELEASE: u8 = 5;
    const DENY_SAVEPOINT_END: u8 = 6;

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
            DENY_SAVEPOINT_ROLLBACK => action == libsqlite3_sys::SQLITE_SAVEPOINT && text(first) == "ROLLBACK",
            DENY_SAVEPOINT_RELEASE => action == libsqlite3_sys::SQLITE_SAVEPOINT && text(first) == "RELEASE",
            DENY_SAVEPOINT_END => action == libsqlite3_sys::SQLITE_SAVEPOINT && matches!(text(first), "ROLLBACK" | "RELEASE"),
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
        let _case = orm_testcase::case!(orm_testcase::DATABASE);
        let _denial = SQLITE_DENIAL.lock().await;
        let tmp = std::env::temp_dir().join(format!("orm-transaction-end-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let db = Db::connect(&format!("sqlite://{}", tmp.join("end.sqlite").display()), 1, crate::Config::default()).await.expect("connect");
        let both = |error: &Error, cause: &str| {
            let text = error.to_string();
            assert!(text.starts_with(&format!("ROLLBACK: transaction failed ({cause}) and rollback failed (")) && text.contains("not authorized"), "{text}");
            // ROLLBACK 오류는 callback 오류와 rollback 오류를 이 순서로 담는다.
            match error {
                Error::Rollback { callback, rollback } => {
                    assert_eq!(callback.to_string(), cause, "callback error");
                    assert!(rollback.to_string().contains("not authorized"), "rollback error: {rollback}");
                }
                other => panic!("ROLLBACK expected: {other:?}"),
            }
        };
        deny_on_sqlite(&db, DENY_ROLLBACK).await;
        let error = db.transaction(async || Err::<(), _>(Error::Config("callback failed".into()))).retry(0).await.expect_err("rollback");
        both(&error, "CONFIG: callback failed");
        deny_on_sqlite(&db, DENY_ROLLBACK).await;
        let panicked =
            std::panic::AssertUnwindSafe(db.transaction(async || -> Result<()> { panic!("callback panicked") }).retry(0).into_future()).catch_unwind().await;
        let payload = panicked.expect_err("the callback panics");
        let text = payload.downcast_ref::<String>().expect("the panic carries the transaction failure");
        assert!(text.starts_with("ROLLBACK: transaction failed (callback panicked) and rollback failed (") && text.contains("not authorized"), "{text}");
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

    // 중첩 transaction의 savepoint를 끝내는 ROLLBACK TO SAVEPOINT나 RELEASE SAVEPOINT가 실패하면 callback
    // 오류, panic, transaction_send와 transaction_once의 중첩 호출이 그 오류를 함께 보고하고, 성공한
    // callback은 실패한 RELEASE SAVEPOINT를 돌려준다.
    #[tokio::test]
    async fn savepoint_end_failures_are_reported() {
        let _case = orm_testcase::case!(orm_testcase::DATABASE);
        let _denial = SQLITE_DENIAL.lock().await;
        let tmp = std::env::temp_dir().join(format!("orm-savepoint-end-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let db = Db::connect(&format!("sqlite://{}", tmp.join("savepoint.sqlite").display()), 1, crate::Config::default()).await.expect("connect");
        let both = |what: &str, text: &str| {
            assert!(
                text.starts_with("ROLLBACK: transaction failed (CONFIG: callback failed) and rollback failed (") && text.contains("not authorized"),
                "{what}: {text}"
            );
        };
        let failed = || async { Err::<(), _>(Error::Config("callback failed".into())) };
        for denied in [DENY_SAVEPOINT_ROLLBACK, DENY_SAVEPOINT_RELEASE, DENY_SAVEPOINT_END] {
            deny_on_sqlite(&db, denied).await;
            let error = db.transaction(async || db.transaction(failed).await).retry(0).await.expect_err("callback error");
            both(&format!("callback error {denied}"), &error.to_string());
            if denied == DENY_SAVEPOINT_END {
                assert_eq!(error.to_string().matches("not authorized").count(), 2, "both savepoint statements are reported: {error}");
            }
            let error = db.transaction(async || db.transaction_send(failed).await).retry(0).await.expect_err("send callback error");
            both(&format!("send callback error {denied}"), &error.to_string());
            let error = db
                .transaction(async || match db.transaction_once(async || Err::<(), _>(DomainFailure::Rejected)).await {
                    Err(TransactionOnceError::Rollback { callback: DomainFailure::Rejected, rollback }) => Err::<(), Error>(rollback),
                    other => panic!("once {denied}: {other:?}"),
                })
                .retry(0)
                .await
                .expect_err("once callback error");
            assert!(error.to_string().contains("not authorized"), "once {denied}: {error}");
            let panicked = std::panic::AssertUnwindSafe(
                db.transaction(async || db.transaction(async || -> Result<()> { panic!("callback panicked") }).await).retry(0).into_future(),
            )
            .catch_unwind()
            .await;
            let payload = panicked.expect_err("the callback panics");
            let text = payload.downcast_ref::<String>().expect("the panic carries the savepoint failure");
            assert!(
                text.starts_with("ROLLBACK: transaction failed (callback panicked) and rollback failed (") && text.contains("not authorized"),
                "panic {denied}: {text}"
            );
        }
        deny_on_sqlite(&db, DENY_SAVEPOINT_RELEASE).await;
        let error = db.transaction(async || db.transaction(async || Ok(())).await).retry(0).await.expect_err("release");
        assert!(error.to_string().contains("not authorized"), "release: {error}");
        SQLITE_DENIED.store(DENY_NOTHING, Ordering::Release);
        db.close().await;
        std::fs::remove_dir_all(tmp).unwrap();
    }

    // transaction 끝의 MySQL local 값 reset이 실패하면 그 오류를 보고한다. MySQL user
    // variable은 COMMIT과 ROLLBACK 뒤에도 남는다(mysql.context.user_variable_session_scope).
    #[tokio::test]
    async fn failed_local_reset_is_reported() {
        let _case = orm_testcase::case!(orm_testcase::DATABASE);
        let db = Db::connect(&required_dsn("ORM_TEST_MYSQL_SERVER_DSN"), 2, crate::Config::default()).await.expect("connect");
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
