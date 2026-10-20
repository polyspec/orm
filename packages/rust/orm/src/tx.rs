//! Callback transactions. Each task keeps a stack of active transactions; a
//! model without a connection runs in the innermost one. A transaction of the
//! same connection inside an active one creates a savepoint.

use std::collections::{HashMap, HashSet};
use std::future::{Future, IntoFuture};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt as _;

use crate::db::{Db, Executor, Pool};
use crate::driver::{CancellableConnection, MySqlOwnedTx, TxInner};
use crate::events::{self, Sent, KIND_BEGIN, KIND_COMMIT, KIND_RELEASE, KIND_ROLLBACK, KIND_ROLLBACK_TO, KIND_SAVEPOINT, KIND_UTILITY};
use crate::markdown::{begin_message, MdControl, MdPool};
use crate::schema::Schema;
use crate::value::Param;
use crate::{codes, Error, Result};

/// One active transaction.
pub(crate) struct TxShared {
    pub(crate) db: Db,
    /// The number of this transaction on the connection. Statement events carry it.
    pub(crate) number: u64,
    pub(crate) inner: tokio::sync::Mutex<Option<TxInner>>,
    pub(crate) finished: AtomicBool,
    savepoints: AtomicU32,
    pub(crate) locals: Mutex<HashMap<String, String>>,
    pub(crate) locks: Mutex<Vec<String>>,
    /// The audit record the transaction inserted right before its first write of an audited table. Inserts and updates of
    /// audit-target tables write its key to the audit column. None until that write and for a transaction with no audit values.
    pub(crate) audit: Mutex<Option<AuditKey>>,
    /// The audit record the transaction inserts before its first write of an audited table; None without audit values.
    pub(crate) pending_audit: Mutex<Option<Arc<AuditInsert>>>,
    /// The identity keys of the generated single inserts that the transaction succeeded in, by entity (INT-52). A savepoint that does not
    /// release restores it.
    pub(crate) inserted: Mutex<HashMap<String, HashSet<i64>>>,
    sqlite_mode: Mutex<Option<(bool, bool)>>,
}

/// The table and primary key value of the audit record the transaction inserted.
#[derive(Clone, Debug)]
pub(crate) struct AuditKey {
    pub(crate) table: String,
    pub(crate) key: Param,
}

/// The transaction's audit values: column names and values of the audit record table.
type AuditValues = Vec<(String, Param)>;

/// Collects the audit values as column names and `Param`s.
fn audit_values<K: Into<String>, V: Into<Param>>(values: impl IntoIterator<Item = (K, V)>) -> AuditValues {
    values.into_iter().map(|(k, v)| (k.into(), v.into())).collect()
}

/// The audit record the transaction inserts: the schema of the registered set that has the record table as an entity, that entity, and the column
/// name-ordered values.
pub(crate) struct AuditInsert {
    pub(crate) schema: &'static Schema,
    pub(crate) entity: polyspec_orm_schema::dbspec::Entity,
    pub(crate) values: AuditValues,
}

/// The audit record made of the audit source's values plus the transaction's values. For the same column, the transaction's value wins.
/// The record table is the one table named in references by the audit setting of a set registered on the connection, and a registered set that has that table as an entity
/// must be registered on the connection. If there is no audit source, or no or several record tables, or a value key
/// is not a column of that table, or the primary key is not a single column, it is CONFIG; a source's error is returned as is.
/// The source is called here once, before the transaction starts.
fn audit_record(db: &Db, values: &AuditValues) -> Result<AuditInsert> {
    db.unsupported_on_markdown("a transaction with audit values")?;
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
        [table] => {
            models.iter().find_map(|(schema, manifest)| manifest.model.entities.iter().find(|e| &e.table == table && !e.external).map(|e| (*schema, e.clone())))
        }
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

/// Inserts the audit record on `ex`. The insert is a write, and a write inserts the pending audit record first, so the
/// future is boxed to end the recursion of their types.
fn insert_audit_boxed<'a>(ex: &'a Executor, record: &'a AuditInsert) -> Pin<Box<dyn Future<Output = Result<AuditKey>> + Send + 'a>> {
    Box::pin(crate::model::insert_audit(ex, record))
}

/// The name of the savepoint that guards the audit record inserted before an update, delete or restore.
const AUDIT_SAVEPOINT: &str = "orm_audit";

impl TxShared {
    /// Makes sure the audit record precedes a write of an audited table: when the transaction has a pending record and
    /// has not inserted it, it inserts it now. `guard` is true for an update, delete or restore, which can match no row:
    /// the record is then inserted inside the savepoint orm_audit, and the result is true; the caller then calls
    /// `settle_audit` with the write's outcome.
    pub(crate) async fn audit_for(self: &Arc<Self>, guard: bool) -> Result<bool> {
        if self.audit.lock().unwrap().is_some() {
            return Ok(false);
        }
        let Some(record) = self.pending_audit.lock().unwrap().clone() else {
            return Ok(false);
        };
        let ex = Executor::Tx(self.clone());
        if !guard {
            let key = insert_audit_boxed(&ex, &record).await?;
            *self.audit.lock().unwrap() = Some(key);
            return Ok(false);
        }
        self.savepoint_step(KIND_SAVEPOINT, AUDIT_SAVEPOINT).await?;
        match insert_audit_boxed(&ex, &record).await {
            Ok(key) => {
                *self.audit.lock().unwrap() = Some(key);
                Ok(true)
            }
            Err(error) => Err(match rollback_savepoint(self, AUDIT_SAVEPOINT).await {
                Ok(()) => error,
                Err(rollback) => Error::rollback(error, rollback),
            }),
        }
    }

    /// Ends the savepoint orm_audit that `audit_for` opened: a write that changed a row keeps the record and releases
    /// the savepoint; a write that changed no row or failed undoes the record and releases the savepoint.
    pub(crate) async fn settle_audit(&self, changed: bool) -> Result<()> {
        if changed {
            return self.savepoint_step(KIND_RELEASE, AUDIT_SAVEPOINT).await;
        }
        *self.audit.lock().unwrap() = None;
        rollback_savepoint(self, AUDIT_SAVEPOINT).await
    }

    /// The transaction's audit record. It is taken out and used before waiting for a statement.
    pub(crate) fn audit(&self) -> Option<AuditKey> {
        self.audit.lock().unwrap().clone()
    }

    /// Whether a generated insert of entity with the identity key succeeded in this transaction (INT-52).
    pub(crate) fn was_inserted(&self, entity: &str, key: i64) -> bool {
        self.inserted.lock().unwrap().get(entity).is_some_and(|keys| keys.contains(&key))
    }

    /// Records a generated insert of entity with the identity key in this transaction (INT-52).
    pub(crate) fn record_inserted(&self, entity: &str, key: i64) {
        self.inserted.lock().unwrap().entry(entity.to_owned()).or_default().insert(key);
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

    /// Runs one step of savepoint `name`: if `kind` is KIND_SAVEPOINT it creates it, if KIND_RELEASE it releases it,
    /// if KIND_ROLLBACK_TO it reverts the work after it. A SQL connection sends that statement and publishes its event, and
    /// a markdown connection sends a control message of the same name (docs/spec/protocol.md §5 "Session").
    pub(crate) async fn savepoint_step(&self, kind: &str, name: &str) -> Result<()> {
        let (op, statement) = match kind {
            KIND_SAVEPOINT => ("savepoint", format!("SAVEPOINT {name}")),
            KIND_RELEASE => ("release", format!("RELEASE SAVEPOINT {name}")),
            KIND_ROLLBACK_TO => ("rollback_to", format!("ROLLBACK TO SAVEPOINT {name}")),
            other => return Err(Error::internal(format!("{other} is no savepoint step"))),
        };
        let mut guard = self.enter()?;
        let inner = guard.as_mut().ok_or_else(|| Error::Config("transaction already finished".into()))?;
        if let TxInner::Markdown(session) = inner {
            return session.call(&MdControl { op, read_only: false, name: Some(name) }).await.map(drop);
        }
        raw_on(&self.db, inner, Sent::bare(kind, &[], Some(self.number), &statement)).await
    }
}

/// Runs a statement without a bind on the transaction connection and publishes its event. A markdown connection
/// does not send the statement.
pub(crate) async fn raw_on(db: &Db, inner: &mut TxInner, s: Sent<'_>) -> Result<()> {
    match inner {
        TxInner::MySql(t) => events::raw(db, &mut **t.conn.as_mut().expect("active MySQL transaction connection"), s).await,
        TxInner::Postgres(t) => events::raw(db, &mut **t, s).await,
        TxInner::Sqlite(t) => events::raw(db, &mut **t, s).await,
        TxInner::Markdown(_) => Err(Error::internal("a markdown transaction sends no statement")),
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
    /// Records the audit of the transaction: right before its first write of an
    /// audited table the transaction inserts one audit record with the defaults of the handle (`Db::audit`)
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

/// The future of the steps the ORM awaits internally (begin, savepoint, commit, rollback). These steps are Send, so
/// `TransactionOnceFuture` is Send when the callback, its future, and the result and error types are Send.
type OnceStep<'a, R> = Pin<Box<dyn Future<Output = R> + Send + 'a>>;

/// The callback future, which runs inside the transaction's task-local frame and catches panics.
type OnceCallback<Fut> = futures_util::future::CatchUnwind<std::panic::AssertUnwindSafe<tokio::task::futures::TaskLocalFuture<Vec<Arc<TxShared>>, Fut>>>;

/// Where the callback runs: a new transaction, or a savepoint of the outer transaction.
enum OnceScope<'a> {
    Transaction {
        db: &'a Db,
        tx: Arc<TxShared>,
    },
    /// `audit` is the transaction's audit before the savepoint, restored when the savepoint does not release.
    Savepoint {
        tx: Arc<TxShared>,
        name: String,
        audit: Option<AuditKey>,
    },
}

impl<'a> OnceScope<'a> {
    fn tx(&self) -> &Arc<TxShared> {
        match self {
            OnceScope::Transaction { tx, .. } | OnceScope::Savepoint { tx, .. } => tx,
        }
    }

    /// After the callback succeeds, commits the transaction or releases the savepoint.
    fn close(self) -> OnceStep<'a, Result<()>> {
        match self {
            OnceScope::Transaction { tx, .. } => Box::pin(async move { commit(&tx).await }),
            OnceScope::Savepoint { tx, name, audit } => Box::pin(async move {
                let released = tx.savepoint_step(KIND_RELEASE, &name).await;
                if released.is_err() {
                    *tx.audit.lock().unwrap() = audit;
                }
                tx.savepoints.fetch_sub(1, Ordering::AcqRel);
                released
            }),
        }
    }

    /// After the callback fails or panics, reverts the work after the transaction or savepoint. The transaction's
    /// rollback consumes the configured test fault.
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
            OnceScope::Savepoint { tx, name, audit } => Box::pin(async move {
                *tx.audit.lock().unwrap() = audit;
                let undone = rollback_savepoint(&tx, &name).await;
                tx.savepoints.fetch_sub(1, Ordering::AcqRel);
                undone
            }),
        }
    }
}

/// The callback's result, returned after the scope ends.
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

// The callback future is pinned only inside a Box; the other fields (callback, result, error) are moved without ever being pinned.
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
                            match tx.savepoint_step(KIND_SAVEPOINT, &name).await {
                                Ok(()) => {
                                    let audit = tx.audit();
                                    Ok(OnceScope::Savepoint { tx, name, audit })
                                }
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
                                // The audit record is inserted right before the first write of an audited table.
                                *tx.pending_audit.lock().unwrap() = record.map(Arc::new);
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
        let record = self.audit.as_ref().map(|values| audit_record(self.db, values)).transpose()?.map(Arc::new);
        let mut attempt = 0u32;
        loop {
            let tx = Arc::new(begin(self.db, self.isolation, self.read_only, self.timeout_ms).await?);
            let mut stack = frames();
            stack.push(tx.clone());
            // Each attempt starts with the pending record and no inserted audit.
            *tx.pending_audit.lock().unwrap() = record.clone();
            let body = (self.f)();
            let callback = std::panic::AssertUnwindSafe(FLOW.scope(stack, body)).catch_unwind();
            let result = match callback.await {
                Ok(result) => result,
                Err(payload) => match rollback_and_resume(&tx, payload).await {},
            };
            match result {
                // A deadlocked commit is retried as a deadlocked callback is, as the other clients retry the whole
                // transaction; any other commit error, such as WRITE_CONFLICT, is returned at once.
                Ok(v) => match commit(&tx).await {
                    Ok(()) => return Ok(v),
                    Err(e) if e.is_deadlock() && attempt < self.retry => {
                        let jitter = rand::random::<u64>() % 20;
                        tokio::time::sleep(std::time::Duration::from_millis((50u64 << attempt.min(10)) + jitter)).await;
                        attempt += 1;
                    }
                    Err(e) => return Err(e),
                },
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

    /// Makes the transaction one unit of work with an audit record. Right before
    /// the first write of an audited table, in every attempt, the transaction
    /// inserts one row into the audit record table: the defaults of the handle (`Db::audit`) with
    /// `values`, of which a value wins over the default of the same column.
    /// Every insert, update, soft delete and restore of an audited table in the
    /// transaction writes the record's primary key into the table's audit
    /// column. The handle must have defaults, and every key must be a column of
    /// the audit record table; otherwise the transaction fails with CONFIG
    /// before it begins. A transaction that writes no audited row inserts no
    /// record: a first update, delete or restore that matches no row undoes the
    /// record with a savepoint, and a rolled back savepoint undoes the record
    /// with the write that inserted it. A nested transaction uses the audit of the outer one
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
        let record = self.audit.as_ref().map(|values| audit_record(self.db, values)).transpose()?.map(Arc::new);
        let mut attempt = 0u32;
        loop {
            let tx = Arc::new(begin(self.db, self.isolation, self.read_only, self.timeout_ms).await?);
            let mut stack = frames();
            stack.push(tx.clone());
            // Each attempt starts with the pending record and no inserted audit.
            *tx.pending_audit.lock().unwrap() = record.clone();
            let body = (self.f)();
            let callback = std::panic::AssertUnwindSafe(FLOW.scope(stack, body)).catch_unwind();
            let result = match callback.await {
                Ok(result) => result,
                Err(payload) => match rollback_and_resume(&tx, payload).await {},
            };
            match result {
                // A deadlocked commit is retried as a deadlocked callback is, as the other clients retry the whole
                // transaction; any other commit error, such as WRITE_CONFLICT, is returned at once.
                Ok(v) => match commit(&tx).await {
                    Ok(()) => return Ok(v),
                    Err(e) if e.is_deadlock() && attempt < self.retry => {
                        let jitter = rand::random::<u64>() % 20;
                        tokio::time::sleep(std::time::Duration::from_millis((50u64 << attempt.min(10)) + jitter)).await;
                        attempt += 1;
                    }
                    Err(e) => return Err(e),
                },
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

/// The result of the callback that finished the savepoint.
enum SavepointEnd<T, E> {
    Returned(std::result::Result<T, (E, Option<Error>)>),
    Panicked(Box<dyn std::any::Any + Send>, Option<Error>),
}

/// Runs the callback inside a savepoint. A callback that succeeds releases the savepoint; one that fails or panics
/// reverts the work after the savepoint and releases it. A callback error is returned together with an error from a savepoint that could not be finished,
/// and a panic is carried on as an error of the same form as a transaction's when such an error exists.
async fn run_savepoint<T, E, Fut>(tx: Arc<TxShared>, callback: Fut) -> Result<std::result::Result<T, (E, Option<Error>)>>
where
    Fut: Future<Output = std::result::Result<T, E>>,
{
    let n = tx.savepoints.fetch_add(1, Ordering::AcqRel) + 1;
    let name = format!("orm_sp_{n}");
    // A savepoint that does not release undoes an audit record inserted inside it.
    let audit_before = tx.audit();
    let inserted_before = tx.inserted.lock().unwrap().clone();
    let mut kept = false;
    let ended = async {
        tx.savepoint_step(KIND_SAVEPOINT, &name).await?;
        let mut stack = frames();
        stack.push(tx.clone());
        Ok::<_, Error>(match std::panic::AssertUnwindSafe(FLOW.scope(stack, callback)).catch_unwind().await {
            Ok(Ok(value)) => {
                tx.savepoint_step(KIND_RELEASE, &name).await?;
                kept = true;
                SavepointEnd::Returned(Ok(value))
            }
            Ok(Err(error)) => SavepointEnd::Returned(Err((error, rollback_savepoint(&tx, &name).await.err()))),
            Err(payload) => SavepointEnd::Panicked(payload, rollback_savepoint(&tx, &name).await.err()),
        })
    }
    .await;
    tx.savepoints.fetch_sub(1, Ordering::AcqRel);
    if !kept {
        *tx.audit.lock().unwrap() = audit_before;
        *tx.inserted.lock().unwrap() = inserted_before;
    }
    match ended? {
        SavepointEnd::Returned(result) => Ok(result),
        SavepointEnd::Panicked(payload, rollback) => resume_panic(payload, rollback),
    }
}

/// Reverts the work after the savepoint and releases it. Both statements are attempted and all failures are returned.
async fn rollback_savepoint(tx: &TxShared, name: &str) -> Result<()> {
    let rolled_back = tx.savepoint_step(KIND_ROLLBACK_TO, name).await;
    let released = tx.savepoint_step(KIND_RELEASE, name).await;
    joined([rolled_back.err(), released.err()].into_iter().flatten().collect())
}

/// Ok if there are no errors, that error if there is one, and CONFIG collecting the messages if there are several.
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
    // The statement that opens a transaction (docs/operations/usage.md "Statement events").
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
            // SQLite's row lock table is created once, before the connection's first transaction.
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
        Pool::Markdown(pool) => return begin_markdown(db, pool, isolation, read_only).await,
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
        pending_audit: Mutex::new(None),
        inserted: Mutex::new(HashMap::new()),
        sqlite_mode: Mutex::new(sqlite_mode),
    };
    let mut began = false;
    for (kind, sql) in &opening {
        if let Err(error) = tx.raw(kind, sql).await {
            if began {
                // An open transaction is reverted. A connection that cannot be reverted is closed.
                return Err(match rollback(&tx).await {
                    Ok(()) => error,
                    Err(rollback) => Error::rollback(error, rollback),
                });
            }
            // A connection that failed before opening is closed so that leftover session settings do not reach the next user.
            tx.finished.store(true, Ordering::Release);
            return Err(error);
        }
        began |= *kind == KIND_BEGIN;
    }
    Ok(tx)
}

/// Opens a markdown transaction: holds one session from the pool until the transaction ends and sends begin. A read-only
/// transaction sends read_only (docs/spec/protocol.md §5 "Session"). Isolation is CAPABILITY_UNSUPPORTED.
async fn begin_markdown(db: &Db, pool: &Arc<MdPool>, isolation: Option<Isolation>, read_only: bool) -> Result<TxShared> {
    if isolation.is_some() {
        db.unsupported_on_markdown("the transaction isolation option")?;
    }
    let mut session = pool.acquire().await?;
    session.call(&begin_message(read_only)).await?;
    Ok(TxShared {
        db: db.clone(),
        number: db.next_transaction(),
        inner: tokio::sync::Mutex::new(Some(TxInner::Markdown(session))),
        finished: AtomicBool::new(false),
        savepoints: AtomicU32::new(0),
        locals: Mutex::new(HashMap::new()),
        locks: Mutex::new(Vec::new()),
        audit: Mutex::new(None),
        pending_audit: Mutex::new(None),
        inserted: Mutex::new(HashMap::new()),
        sqlite_mode: Mutex::new(None),
    })
}

/// The table that the SQLite row lock uses.
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

/// Rolls back the transaction of a callback that panicked and continues the panic. If the rollback fails,
/// the panic message carries both the cause and the failed rollback (docs/spec/interfaces.md).
async fn rollback_and_resume(tx: &TxShared, payload: Box<dyn std::any::Any + Send>) -> std::convert::Infallible {
    resume_panic(payload, rollback(tx).await.err())
}

/// the panic continues. If the transaction or savepoint could not be ended, the panic value carries the cause and
/// the text of the ROLLBACK error.
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
/// the transaction ends. This state remains on the connection after COMMIT and ROLLBACK, so
/// every step is attempted and all failures are returned. If the RELEASE_LOCK result is not 1, this
/// means the connection did not hold the lock.
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
        // Statements that clear values run in key order.
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

/// Runs the statement that ends the transaction (COMMIT or ROLLBACK). If it succeeds and is `clean`, it returns the connection to the pool;
/// if it fails or an earlier cleanup failed (not `clean`), it closes the connection of unknown state. Connections returned to the pool
/// are either clean or discarded.
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
        // A markdown connection sends a control message of the same name. The pool closes a failed session.
        TxInner::Markdown(mut session) => {
            let op = match kind {
                KIND_COMMIT => "commit",
                KIND_ROLLBACK => "rollback",
                other => return Err(Error::internal(format!("{other} does not end a transaction"))),
            };
            session.call(&MdControl { op, read_only: false, name: None }).await?;
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

/// After the transaction is rolled back, consumes the configured test fault: that rollback
/// is reported as failed with `FAULT` (`polyspec_orm::testing::fail_next_rollback`, feature
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

    /// A directory of its own for one test, removed when the value is dropped. A test that fails an assertion
    /// unwinds through the drop, so it leaves nothing behind either.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(prefix: &str) -> Self {
            let path = std::env::temp_dir().join(format!("{prefix}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Scratch(path)
        }

        fn join(&self, name: &str) -> std::path::PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            // A failed removal fails a test that passed; during a panic it is left to the panic already reported.
            if let Err(error) = std::fs::remove_dir_all(&self.0) {
                if !std::thread::panicking() {
                    panic!("remove {}: {error}", self.0.display());
                }
            }
        }
    }

    #[test]
    fn scratch_is_removed_after_a_failed_assertion() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let path = std::sync::Mutex::new(None);
        let unwound = std::panic::catch_unwind(|| {
            let scratch = Scratch::new("orm-scratch-unwind");
            std::fs::write(scratch.join("left.sqlite"), b"x").unwrap();
            *path.lock().unwrap() = Some(scratch.0.clone());
            panic!("a failed assertion");
        });
        assert!(unwound.is_err(), "the body panicked");
        let path = path.lock().unwrap().clone().unwrap();
        assert!(!path.exists(), "{} is left after the panic", path.display());
    }

    #[expect(dead_code, reason = "a compile-time check: its body proves the future of transaction_send is Send, and nothing calls it")]
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
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
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
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let error = TransactionOnceError::Rollback { callback: DomainFailure::Rejected, rollback: Error::Config("rollback rejected".into()) };
        assert!(error.to_string().contains("request rejected"));
        assert!(error.to_string().contains("rollback rejected"));
        assert_eq!(std::error::Error::source(&error).unwrap().to_string(), "request rejected");
    }

    #[tokio::test]
    async fn one_shot_transaction_preserves_callback_error_and_rolls_back() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let tmp = Scratch::new("orm-once");
        // The probe table is kept in the case's own database, not a shared test database, so that
        // another run dropping a table of the same name, or a table left by a panicked run, cannot disturb this case.
        let mysql = polyspec_orm_case_database::CaseDatabase::create("mysql").await;
        let postgres = polyspec_orm_case_database::CaseDatabase::create("postgres").await;
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
                Pool::Markdown(_) => unreachable!("the transaction tests connect to SQL databases"),
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
                Pool::Markdown(_) => unreachable!("the transaction tests connect to SQL databases"),
            };
            assert_eq!(count, 3, "{driver}: committed rows");
            execute(&db, "DROP TABLE orm_once_probe").await;
            db.close().await;
        }
        mysql.drop().await;
        postgres.drop().await;
    }

    fn required_dsn(name: &str) -> String {
        std::env::var(name).ok().filter(|dsn| !dsn.is_empty()).unwrap_or_else(|| panic!("{name} is required; database tests never skip"))
    }

    async fn execute(db: &Db, statement: &str) {
        match db.pool() {
            Pool::MySql(pool) => sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned())).execute(pool).await.map(|_| ()),
            Pool::Postgres(pool) => sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned())).execute(pool).await.map(|_| ()),
            Pool::Sqlite(pool) => sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned())).execute(pool).await.map(|_| ()),
            Pool::Markdown(_) => unreachable!("the transaction tests connect to SQL databases"),
        }
        .unwrap();
    }

    async fn count(db: &Db) -> i64 {
        match db.pool() {
            Pool::MySql(pool) => sqlx::query_scalar("SELECT COUNT(*) FROM orm_timeout_probe").fetch_one(pool).await,
            Pool::Postgres(pool) => sqlx::query_scalar("SELECT COUNT(*) FROM orm_timeout_probe").fetch_one(pool).await,
            Pool::Sqlite(pool) => sqlx::query_scalar("SELECT COUNT(*) FROM orm_timeout_probe").fetch_one(pool).await,
            Pool::Markdown(_) => unreachable!("the transaction tests connect to SQL databases"),
        }
        .unwrap()
    }

    /// On PostgreSQL, `timeout_ms` is `SET LOCAL statement_timeout`, so the server ends a long-running statement
    /// and the transaction is rolled back. MySQL and SQLite do not support that option, so the transaction
    /// fails with CAPABILITY_UNSUPPORTED before it starts, and the callback does not run (docs/spec/interfaces.md).
    /// 0 is the same as not giving the option. Mismatches from each database are collected and reported together at the end.
    #[tokio::test]
    async fn transaction_timeout_is_the_postgres_statement_timeout() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let tmp = Scratch::new("orm-timeout");
        // The probe table is kept in the case's own database (as in one_shot_transaction_preserves_callback_error_and_rolls_back).
        let mysql = polyspec_orm_case_database::CaseDatabase::create("mysql").await;
        let postgres = polyspec_orm_case_database::CaseDatabase::create("postgres").await;
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
        assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
    }

    /// Opens a MySQL transaction, sets a local value, then kills that connection from another connection.
    /// The real server does not reject `SET @`orm.…` = NULL`, so the reset is made to fail with the killed connection.
    /// Since this test kills a server session, db connects to the server at ORM_TEST_MYSQL_SERVER_DSN, not through a pooler,
    /// because ProxySQL takes KILL as a command for its own client session.
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

    // If the MySQL RELEASE_LOCK at the end of the transaction fails to release the lock (result is not 1), its result is reported.
    // An unreleased named lock remains on the connection after COMMIT and ROLLBACK.
    #[tokio::test]
    async fn lock_not_held_at_transaction_end_is_reported() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let db = Db::connect(&required_dsn("ORM_TEST_MYSQL_DSN"), 2, crate::Config::default()).await.expect("connect");
        let key = format!("orm_test.released.{}", std::process::id());
        let result = db
            .transaction(async || {
                db.utils().lock(&key).await?;
                // If the lock is released early, RELEASE_LOCK at the end of the transaction returns 0.
                active_for(&db).expect("transaction active").raw(KIND_UTILITY, &format!("DO RELEASE_LOCK('{key}')")).await
            })
            .retry(0)
            .await;
        let error = result.expect_err("a lock released early is reported");
        assert!(error.to_string().contains(&format!("lock {key} was not held at transaction end")), "{error}");
        db.close().await;
    }

    // A connection whose cleanup at the end of the transaction failed is closed and does not return to the pool. After a failed cleanup, the session's
    // state is unknown, so a connection returned to the pool is either clean or discarded. In a pool with one connection,
    // if the next use gets the same session (CONNECTION_ID), the connection has come back. After a failed cleanup, commit
    // closes the connection, and rollback must too. A transaction that finishes cleanly reuses the same session.
    // This test looks at the session, so it connects to the server at ORM_TEST_MYSQL_SERVER_DSN, not through a pooler.
    #[tokio::test]
    async fn failed_cleanup_discards_the_connection() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
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
                    // If the lock is released early, RELEASE_LOCK at the end of the transaction returns 0, and the cleanup fails.
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

    // Even if RELEASE_LOCK fails, the local value reset is still attempted, and both failures are reported.
    #[tokio::test]
    async fn every_failed_cleanup_step_is_reported() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let db = Db::connect(&required_dsn("ORM_TEST_MYSQL_SERVER_DSN"), 2, crate::Config::default()).await.expect("connect");
        let tx = transaction_with_failing_reset(&db).await;
        tx.locks.lock().unwrap().push(format!("orm_test.killed.{}", std::process::id()));
        let mut inner = tx.inner.lock().await.take().expect("transaction inner");
        let cleanup = finish(&tx, &mut inner).await.expect_err("the cleanup of a killed connection fails");
        drop(inner);
        assert_eq!(cleanup.to_string().split("; ").count(), 2, "the release and the reset are both reported: {cleanup}");
        db.close().await;
    }

    // The transaction of a callback that panicked ends by closing the connection. The server ends that session's transaction and
    // named lock, so another connection takes the lock.
    #[tokio::test]
    async fn panicking_callback_ends_its_transaction() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
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
        // The server waits until the closed session's lock is released.
        let got: Option<i64> = sqlx::query_scalar("SELECT GET_LOCK(?, 5)").bind(&key).fetch_one(&mut *other).await.expect("GET_LOCK");
        assert_eq!(got, Some(1), "the panicked transaction released its lock");
        let released: Option<i64> = sqlx::query_scalar("SELECT RELEASE_LOCK(?)").bind(&key).fetch_one(&mut *other).await.expect("RELEASE_LOCK");
        assert_eq!(released, Some(1));
        drop(other);
        db.close().await;
    }

    // A transaction future dropped before it finished closes the connection. The server ends that session's
    // transaction and lock, so another connection takes the lock. The MySQL test server's
    // The connection uses TLS, and sqlx's TLS stream shutdown waits for data the server does not send.
    // This test watches the end of a server session, so it connects to the servers at ORM_TEST_MYSQL_SERVER_DSN and
    // ORM_TEST_POSTGRES_SERVER_DSN, not through a pooler.
    // On SQLite, the write transaction of the closed connection ends, so another connection takes the write lock.
    #[tokio::test]
    async fn dropped_transaction_closes_its_connection() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let tmp = Scratch::new("orm-dropped");
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
                Pool::Markdown(_) => unreachable!("the transaction tests connect to SQL databases"),
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
    }

    /// The SQLite authorizer denies the statement chosen by sqlite_denied. Real SQLite does not reject the end-of-transaction
    /// ROLLBACK and PRAGMA, so the failure is produced this way.
    static SQLITE_DENIED: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(DENY_NOTHING);
    /// SQLITE_DENIED is one per process, so tests that use it hold this lock and run one at a time.
    static SQLITE_DENIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    const DENY_NOTHING: u8 = 0;
    const DENY_ROLLBACK: u8 = 1;
    const DENY_QUERY_ONLY_ON: u8 = 2;
    const DENY_QUERY_ONLY_OFF: u8 = 3;
    const DENY_SAVEPOINT_ROLLBACK: u8 = 4;
    const DENY_SAVEPOINT_RELEASE: u8 = 5;
    const DENY_SAVEPOINT_END: u8 = 6;

    #[allow(unsafe_code, reason = "SQLite calls the authorizer through its C ABI with raw C strings, and sqlx exposes no safe authorizer")]
    unsafe extern "C" fn sqlite_authorizer(
        _: *mut std::ffi::c_void,
        action: std::ffi::c_int,
        first: *const std::ffi::c_char,
        second: *const std::ffi::c_char,
        _: *const std::ffi::c_char,
        _: *const std::ffi::c_char,
    ) -> std::ffi::c_int {
        // SAFETY: SQLite passes a null or NUL-terminated string.
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

    /// Puts the authorizer on the pool's only connection so that it denies `denied`.
    #[allow(unsafe_code, reason = "sqlx exposes no safe authorizer, so the test sets it through the C function sqlite3_set_authorizer on the raw handle")]
    async fn deny_on_sqlite(db: &Db, denied: u8) {
        let Pool::Sqlite(pool) = db.pool() else { panic!("SQLite pool") };
        let mut conn = pool.acquire().await.expect("SQLite connection");
        let mut handle = conn.lock_handle().await.expect("SQLite handle");
        // SAFETY: the handle is an open connection, and the authorizer is a 'static function.
        let rc = unsafe { libsqlite3_sys::sqlite3_set_authorizer(handle.as_raw_handle().as_ptr(), Some(sqlite_authorizer), std::ptr::null_mut()) };
        assert_eq!(rc, libsqlite3_sys::SQLITE_OK, "sqlite3_set_authorizer");
        SQLITE_DENIED.store(denied, Ordering::Release);
    }

    // If the native rollback, the SQLite mode restore, or begin's PRAGMA fails, the transaction reports that error along with its cause
    // , and the connection of an unfinished transaction is closed so that the next transaction starts fresh.
    #[tokio::test]
    async fn sqlite_transaction_end_failures_are_reported() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let _denial = SQLITE_DENIAL.lock().await;
        let tmp = Scratch::new("orm-transaction-end");
        let db = Db::connect(&format!("sqlite://{}", tmp.join("end.sqlite").display()), 1, crate::Config::default()).await.expect("connect");
        let both = |error: &Error, cause: &str| {
            let text = error.to_string();
            assert!(text.starts_with(&format!("ROLLBACK: transaction failed ({cause}) and rollback failed (")) && text.contains("not authorized"), "{text}");
            // The ROLLBACK error holds the callback error and the rollback error, in that order.
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
    }

    // If ROLLBACK TO SAVEPOINT or RELEASE SAVEPOINT, which end a nested transaction's savepoint, fails, the callback
    // error, panic, and nested calls of transaction_send and transaction_once report that error together, and a successful
    // callback returns the failed RELEASE SAVEPOINT.
    #[tokio::test]
    async fn savepoint_end_failures_are_reported() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let _denial = SQLITE_DENIAL.lock().await;
        let tmp = Scratch::new("orm-savepoint-end");
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
    }

    // If the MySQL local value reset at the end of the transaction fails, that error is reported. The MySQL user
    // variable remains after COMMIT and ROLLBACK (mysql.context.user_variable_session_scope).
    #[tokio::test]
    async fn failed_local_reset_is_reported() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
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
