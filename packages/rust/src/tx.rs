//! Callback transactions (docs/spec/core.md CORE-20 to CORE-26). A transaction callback receives the handle `Tx`, the only
//! way into the transaction; a savepoint is `Tx::savepoint`. No execution flow keeps an active transaction.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::FutureExt as _;

use crate::db::{Db, Executor, Pool};
use crate::driver::{CancellableConnection, MySqlOwnedTx, TxInner};
use crate::events::{self, Sent, KIND_BEGIN, KIND_COMMIT, KIND_RELEASE, KIND_ROLLBACK, KIND_ROLLBACK_TO, KIND_SAVEPOINT, KIND_UTILITY};
use crate::schema::SchemaRef;
use crate::utils::Utils;
use crate::value::{Param, Val};
use crate::{Error, Kind, Result};

/// One active transaction.
pub(crate) struct TxShared {
    pub(crate) db: Db,
    /// The number of this transaction on the connection. Statement events carry it.
    pub(crate) number: u64,
    pub(crate) inner: tokio::sync::Mutex<Option<TxInner>>,
    pub(crate) finished: AtomicBool,
    /// The depth of the handle whose statements may run: 0 for the transaction, n while the callback of the n-th nested
    /// savepoint runs (CORE-22).
    running: AtomicU32,
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

/// The audit record the transaction inserts: the schema of the registered set that has the record table as an entity, that entity, and the column
/// name-ordered values.
pub(crate) struct AuditInsert {
    pub(crate) schema: SchemaRef,
    pub(crate) entity: polyspec_orm_schema::dbspec::Entity,
    pub(crate) values: AuditValues,
}

/// The audit record made of the audit source's values plus the transaction's values. For the same column, the transaction's value wins.
/// The record table is the one table named in references by the audit setting of a set registered on the connection, and a registered set that has that table as an entity
/// must be registered on the connection. If there is no audit source, or no or several record tables, or a value key
/// is not a column of that table, or the primary key is not a single column, it is CONFIG; a source's error is returned as is.
/// The source is called here once, before the transaction starts.
fn audit_record(db: &Db, values: &AuditValues) -> Result<AuditInsert> {
    let Some(source) = &db.inner.cfg.audit_source else {
        return Err(Error::config("the transaction has audit values but the connection has no audit source: set Config::audit_source"));
    };
    let schemas: Vec<SchemaRef> = db.inner.schemas.read().unwrap().clone();
    let mut models = Vec::new();
    for schema in schemas {
        let manifest = schema.manifest()?;
        models.push((schema, manifest));
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
        [] => return Err(Error::config("the transaction has audit values but no set of the connection has an audited table")),
        [table] => models
            .iter()
            .find_map(|(schema, manifest)| manifest.model.entities.iter().find(|e| &e.table == table && !e.external).map(|e| (schema.clone(), e.clone()))),
        _ => {
            return Err(Error::config(format!(
                "the audited tables of the connection record their audits in {}; one audit record table is required",
                tables.join(", ")
            )));
        }
    };
    let Some((schema, entity)) = target else {
        return Err(Error::config(format!("the audit record table {} is not a table of a set registered on the connection", tables[0])));
    };
    if entity.primary_key.len() != 1 {
        return Err(Error::config(format!("the audit record table {} needs a primary key of one column", entity.table)));
    }
    let given = source()?;
    let mut merged: Vec<(String, Param)> = Vec::new();
    for set in [&given, values] {
        let mut sorted: Vec<&(String, Param)> = set.iter().collect();
        sorted.sort_by(|a, b| a.0.cmp(&b.0));
        for (column, value) in sorted {
            if entity.field(column).is_none() {
                return Err(Error::config(format!("audit value {column} is not a column of {}", entity.table)));
            }
            match merged.iter_mut().find(|(c, _)| c == column) {
                Some(slot) => slot.1 = value.clone(),
                None => merged.push((column.clone(), value.clone())),
            }
        }
    }
    merged.sort_by(|a, b| a.0.cmp(&b.0));
    if merged.is_empty() {
        return Err(Error::config(format!("the audit record of {} has no value: the audit source and the transaction give none", entity.table)));
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
    fn new(db: &Db, inner: TxInner, sqlite_mode: Option<(bool, bool)>) -> Self {
        Self {
            db: db.clone(),
            number: db.next_transaction(),
            inner: tokio::sync::Mutex::new(Some(inner)),
            finished: AtomicBool::new(false),
            running: AtomicU32::new(0),
            locals: Mutex::new(HashMap::new()),
            locks: Mutex::new(Vec::new()),
            audit: Mutex::new(None),
            pending_audit: Mutex::new(None),
            inserted: Mutex::new(HashMap::new()),
            sqlite_mode: Mutex::new(sqlite_mode),
        }
    }

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
                Err(rollback) => Error::rollback_failed_of(error, rollback),
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

    /// Marks the start of a statement: a finished transaction is `transaction_ended` (CORE-23), and a statement while
    /// another statement of the transaction runs is `busy` (CORE-22).
    pub(crate) fn enter(&self) -> Result<tokio::sync::MutexGuard<'_, Option<TxInner>>> {
        if self.finished.load(Ordering::Acquire) {
            return Err(Error::new(Kind::TransactionEnded, "the transaction has ended"));
        }
        self.inner.try_lock().map_err(|_locked| Error::new(Kind::Busy, "another statement of the transaction is running"))
    }

    /// Runs a statement text of `kind` on the transaction connection and
    /// publishes its event.
    pub(crate) async fn raw(&self, kind: &str, sql: &str) -> Result<()> {
        let mut guard = self.enter()?;
        let inner = guard.as_mut().ok_or_else(|| Error::config("transaction already finished"))?;
        raw_on(&self.db, inner, Sent::bare(kind, &[], Some(self.number), sql)).await
    }

    /// Runs one step of savepoint `name`: if `kind` is KIND_SAVEPOINT it creates it, if KIND_RELEASE it releases it,
    /// if KIND_ROLLBACK_TO it reverts the work after it. The connection sends that statement and publishes its event; a markdown
    /// connection sends it as a statement of the session (docs/spec/protocol.md PRT-65).
    pub(crate) async fn savepoint_step(&self, kind: &str, name: &str) -> Result<()> {
        let statement = match kind {
            KIND_SAVEPOINT => format!("SAVEPOINT {name}"),
            KIND_RELEASE => format!("RELEASE SAVEPOINT {name}"),
            KIND_ROLLBACK_TO => format!("ROLLBACK TO SAVEPOINT {name}"),
            other => return Err(Error::internal(format!("{other} is no savepoint step"))),
        };
        // A new savepoint is refused after the cancellation; its release and its rollback are sent (CORE-46).
        if kind == KIND_SAVEPOINT {
            self.db.ensure_not_canceled()?;
        }
        let mut guard = self.enter()?;
        let inner = guard.as_mut().ok_or_else(|| Error::config("transaction already finished"))?;
        // A transaction that SQLite rolled back by itself took its savepoints with it (INT-155).
        if let TxInner::Sqlite(t) = inner {
            if kind != KIND_SAVEPOINT && !crate::db::sqlite_in_transaction(t).await? {
                return Ok(());
            }
        }
        raw_on(&self.db, inner, Sent::bare(kind, &[], Some(self.number), &statement)).await
    }
}

/// Runs a statement without a bind on the transaction connection and publishes its event.
pub(crate) async fn raw_on(db: &Db, inner: &mut TxInner, s: Sent<'_>) -> Result<()> {
    match inner {
        TxInner::MySql(t) => events::raw(db, &mut **t.conn.as_mut().expect("active MySQL transaction connection"), s).await,
        TxInner::Postgres(t) => events::raw(db, &mut **t, s).await,
        TxInner::Sqlite(t) => events::raw(db, &mut **t, s).await,
        TxInner::Markdown(t) => events::raw(db, t, s).await,
    }
}

/// A connection that a model or a utility runs on: the pool of a `Db`, or a transaction handle `Tx` (CORE-20, OM-2.8).
#[derive(Clone)]
pub enum Connection {
    /// Every statement borrows a connection of the pool.
    Db(Db),
    /// Every statement runs in the transaction of the handle.
    Tx(Tx),
}

impl Connection {
    /// The database of the connection.
    #[must_use]
    pub fn db(&self) -> &Db {
        match self {
            Connection::Db(db) => db,
            Connection::Tx(tx) => &tx.shared.db,
        }
    }

    /// The utilities of the connection: those of the `Db`, or those of the transaction of the `Tx`.
    #[must_use]
    pub fn utils(&self) -> Utils<'_> {
        match self {
            Connection::Db(db) => db.utils(),
            Connection::Tx(tx) => tx.utils(),
        }
    }

    /// Where a statement of this connection runs. A transaction handle checks its state first (CORE-22, CORE-23).
    pub(crate) fn executor(&self) -> Result<Executor> {
        match self {
            Connection::Db(db) => Ok(Executor::Db(db.clone())),
            Connection::Tx(tx) => tx.executor(),
        }
    }
}

impl From<&Db> for Connection {
    fn from(db: &Db) -> Self {
        Connection::Db(db.clone())
    }
}

impl From<&Connection> for Connection {
    fn from(connection: &Connection) -> Self {
        connection.clone()
    }
}

impl From<&Tx> for Connection {
    fn from(tx: &Tx) -> Self {
        Connection::Tx(tx.clone())
    }
}

/// Where a model runs: its connection, or `config` for a model with none (CORE-20).
pub(crate) fn resolve(conn: &Option<Connection>) -> Result<Executor> {
    match conn {
        Some(connection) => connection.executor(),
        None => Err(Error::config("the model has no connection; connect it to a Db or to the Tx of a transaction")),
    }
}

/// The handle of one transaction or one of its savepoints (CORE-20, CORE-21). A clone is the same handle. A statement
/// through the handle runs in the transaction; a statement while another statement of the transaction runs is `busy`, a
/// statement while a savepoint callback of the handle runs is `busy`, and a statement after the callback of the handle
/// returned is `transaction_ended` (CORE-22, CORE-23).
#[derive(Clone)]
pub struct Tx {
    shared: Arc<TxShared>,
    /// 0 for the transaction, n for the n-th nested savepoint.
    depth: u32,
    /// Whether the callback that received the handle is still running.
    open: Arc<AtomicBool>,
}

impl std::fmt::Debug for Tx {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tx").field("transaction", &self.shared.number).field("depth", &self.depth).finish()
    }
}

impl Tx {
    fn new(shared: Arc<TxShared>, depth: u32) -> Self {
        Tx { shared, depth, open: Arc::new(AtomicBool::new(true)) }
    }

    /// The executor of a statement through the handle, after the checks of CORE-22 and CORE-23. The statement itself takes
    /// the connection of the transaction with a try lock, so an overlapping statement is `busy` too.
    pub(crate) fn executor(&self) -> Result<Executor> {
        self.check()?;
        Ok(Executor::Tx(Arc::clone(&self.shared)))
    }

    fn check(&self) -> Result<()> {
        if !self.open.load(Ordering::Acquire) || self.shared.finished.load(Ordering::Acquire) {
            return Err(Error::new(Kind::TransactionEnded, "the callback of the transaction handle has returned"));
        }
        if self.shared.running.load(Ordering::Acquire) != self.depth {
            return Err(Error::new(Kind::Busy, "a savepoint callback of the transaction handle is running"));
        }
        Ok(())
    }

    /// The database of the transaction.
    #[must_use]
    pub fn db(&self) -> &Db {
        &self.shared.db
    }

    /// The utilities of the transaction: locks, local values, the statement runner and the inserted keys (INT-50 to
    /// INT-52, INT-150).
    #[must_use]
    pub fn utils(&self) -> Utils<'_> {
        Utils::of_transaction(self)
    }

    /// Runs one statement of kind `kind` that touches `tables` (empty when none), with `params` bound in order, in the
    /// transaction, records one statement event (INT-77) and returns its rows (INT-150).
    pub async fn run(&self, kind: &str, tables: &[&str], sql: &str, params: &[Param]) -> Result<Vec<Vec<Val>>> {
        let ex = self.executor()?;
        let tables: Vec<String> = tables.iter().map(|t| (*t).to_owned()).collect();
        let types: Vec<&str> = params.iter().map(bind_type).collect();
        let mut st = crate::utils::step(sql.to_owned(), &types);
        for (slot, p) in st.bind_slots.iter_mut().zip(params) {
            if matches!(p, Param::DateTime(_)) {
                slot.precision = 6;
            }
        }
        let rows = ex.query_as(Some(kind), Some(&tables), &st, params, Vec::new()).await?;
        let zone = self.shared.db.inner.zone;
        rows.iter().map(|r| crate::row::read_frame_row(r, zone)).collect()
    }

    /// Runs one compiled statement `step` with `params` in the transaction, as `Db::execute` does on the pool.
    pub async fn execute(&self, step: &crate::plan::Step, params: &[Param]) -> Result<()> {
        crate::db::execute_step(self.executor()?, step, params).await
    }

    /// Runs `callback` in a savepoint of the transaction and passes it the handle of the savepoint (CORE-21). A callback
    /// that succeeds releases the savepoint. A callback that fails or panics reverts the work after the savepoint and
    /// releases it, and its failure is returned unchanged; when the savepoint cannot be ended too, the result is
    /// `rollback_failed` (CORE-25). A panic is the error `internal` (CORE-26). While the callback runs, every statement
    /// through this handle is `busy` (CORE-22).
    pub async fn savepoint<T, F, Fut>(&self, callback: F) -> Result<T>
    where
        F: FnOnce(Tx) -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        self.check()?;
        let depth = self.depth + 1;
        if self.shared.running.compare_exchange(self.depth, depth, Ordering::AcqRel, Ordering::Acquire).is_err() {
            return Err(Error::new(Kind::Busy, "a savepoint callback of the transaction handle is running"));
        }
        let ended = self.savepoint_at(depth, callback).await;
        self.shared.running.store(self.depth, Ordering::Release);
        ended
    }

    async fn savepoint_at<T, F, Fut>(&self, depth: u32, callback: F) -> Result<T>
    where
        F: FnOnce(Tx) -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        let tx = &self.shared;
        let name = format!("orm_sp_{depth}");
        // A savepoint that does not release undoes an audit record inserted inside it.
        let audit_before = tx.audit();
        let inserted_before = lock(&tx.inserted)?.clone();
        tx.savepoint_step(KIND_SAVEPOINT, &name).await?;
        let child = Tx::new(Arc::clone(tx), depth);
        let open = Arc::clone(&child.open);
        let outcome = std::panic::AssertUnwindSafe(callback(child)).catch_unwind().await;
        open.store(false, Ordering::Release);
        let failure = match outcome {
            Ok(Ok(value)) => match tx.savepoint_step(KIND_RELEASE, &name).await {
                Ok(()) => return Ok(value),
                Err(error) => error,
            },
            Ok(Err(error)) => error,
            Err(payload) => panicked(payload),
        };
        *lock(&tx.audit)? = audit_before;
        *lock(&tx.inserted)? = inserted_before;
        match rollback_savepoint(tx, &name).await {
            Ok(()) => Err(failure),
            Err(rollback) => Err(Error::rollback_failed_of(failure, rollback)),
        }
    }
}

/// The error `internal` of a callback that panicked (CORE-26).
fn panicked(payload: Box<dyn std::any::Any + Send>) -> Error {
    let text = match (payload.downcast_ref::<&str>(), payload.downcast_ref::<String>()) {
        (Some(text), _) => (*text).to_owned(),
        (None, Some(text)) => text.clone(),
        (None, None) => "a panic without a text payload".to_owned(),
    };
    Error::internal(format!("the callback panicked: {text}"))
}

/// Locks a mutex of the transaction state; a poisoned mutex is `internal` (B-7 of the plan).
fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    mutex.lock().map_err(|_poisoned| Error::internal("a lock of the transaction state was poisoned by a panic"))
}

/// The bind type of a parameter: the type its bind slot checks (bind_check).
fn bind_type(p: &Param) -> &'static str {
    match p {
        Param::Null | Param::Str(_) => "text",
        Param::Bool(_) => "bool",
        Param::I64(_) => "i64",
        Param::F64(_) => "f64",
        Param::Bytes(_) => "bytes",
        Param::DateTime(_) => "datetime",
        Param::Date(_) => "date",
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

/// The options of a transaction (CORE-20, INT-40 to INT-44). An absent option has the value that the core states.
#[derive(Clone, Debug, Default)]
pub struct TransactionOptions {
    /// The isolation level; absent keeps the level of the server.
    pub isolation: Option<Isolation>,
    /// Whether the transaction is read-only (INT-41); absent is false.
    pub read_only: Option<bool>,
    /// The bound of every statement of the transaction in milliseconds (INT-42): PostgreSQL sends
    /// `SET LOCAL statement_timeout = <ms>` after its `BEGIN`, MySQL and SQLite fail with `capability_unsupported`;
    /// absent or zero sets no bound.
    pub timeout_ms: Option<u64>,
    /// How many times a callback that failed with `deadlock` runs again (INT-43, CORE-24); absent is 3.
    pub retry: Option<u32>,
    /// The audit values of the unit of work (INT-44).
    pub audit: Option<Vec<(String, Param)>>,
}

/// The number of retries of a transaction whose options state none (INT-43).
pub const DEFAULT_RETRY: u32 = 3;

/// The wait before attempt `attempt` (from 1) of a retried transaction: `50 << (attempt - 1)` milliseconds and `jitter`
/// (CORE-24).
fn retry_wait(attempt: u32, jitter: u64) -> std::time::Duration {
    std::time::Duration::from_millis((50u64 << attempt.saturating_sub(1).min(10)) + jitter)
}

impl Db {
    /// Runs `callback` in a new transaction on a connection of the pool and passes it the transaction handle (CORE-20). A
    /// callback that succeeds commits. A callback that fails or panics rolls back, and its failure is returned unchanged
    /// (CORE-25), a panic as `internal` (CORE-26); when the rollback fails too, the result is `rollback_failed`. A failure
    /// of the kind `deadlock`, of the callback or of the commit, runs the whole callback again after the wait of CORE-24,
    /// `retry` times at most.
    pub async fn transaction<T, F, Fut>(&self, callback: F, options: TransactionOptions) -> Result<T>
    where
        F: Fn(Tx) -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        let TransactionOptions { isolation, read_only, timeout_ms, retry, audit } = options;
        let read_only = read_only == Some(true);
        // An absent or zero bound sets none (INT-42).
        let timeout_ms = timeout_ms.filter(|ms| *ms > 0);
        let retry = match retry {
            Some(n) => n,
            None => DEFAULT_RETRY,
        };
        let record = audit.as_ref().map(|values| audit_record(self, values)).transpose()?.map(Arc::new);
        let mut attempt = 0u32;
        loop {
            let shared = Arc::new(begin(self, isolation, read_only, timeout_ms).await?);
            // Each attempt starts with the pending record and no inserted audit.
            *lock(&shared.pending_audit)? = record.clone();
            let tx = Tx::new(Arc::clone(&shared), 0);
            let open = Arc::clone(&tx.open);
            let outcome = std::panic::AssertUnwindSafe(callback(tx)).catch_unwind().await;
            open.store(false, Ordering::Release);
            let failure = match outcome {
                // A deadlocked commit is retried as a deadlocked callback is; any other commit error, such as
                // write_conflict, is returned at once.
                Ok(Ok(value)) => match commit(&shared).await {
                    Ok(()) => return Ok(value),
                    Err(error) => error,
                },
                Ok(Err(error)) => match rollback(&shared).await.and_then(|()| rollback_fault(self)) {
                    Ok(()) => error,
                    Err(rollback) => return Err(Error::rollback_failed_of(error, rollback)),
                },
                Err(payload) => {
                    let error = panicked(payload);
                    return Err(match rollback(&shared).await {
                        Ok(()) => error,
                        Err(rollback) => Error::rollback_failed_of(error, rollback),
                    });
                }
            };
            if !failure.is_deadlock() || attempt >= retry {
                return Err(failure);
            }
            attempt += 1;
            tokio::time::sleep(retry_wait(attempt, rand::random::<u64>() % 20)).await;
        }
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
        _ => Err(Error::config(errors.iter().map(ToString::to_string).collect::<Vec<_>>().join("; "))),
    }
}

async fn begin(db: &Db, isolation: Option<Isolation>, read_only: bool, timeout_ms: Option<u64>) -> Result<TxShared> {
    db.ensure_open()?;
    // The BEGIN of a handle whose cancellation has fired is not sent (CORE-46).
    db.ensure_not_canceled()?;
    if timeout_ms.is_some() && !matches!(db.pool(), Pool::Postgres(_)) {
        return Err(Error::new(crate::Kind::CapabilityUnsupported, "transaction timeoutMs is supported only by postgres"));
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
            if let Some(ms) = timeout_ms {
                opening.push((KIND_UTILITY, format!("SET LOCAL statement_timeout = {ms}")));
            }
            TxInner::Postgres(CancellableConnection::new(p.acquire().await?))
        }
        Pool::Sqlite(_) | Pool::Markdown(_) => {
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
            match db.pool() {
                Pool::Sqlite(p) => TxInner::Sqlite(CancellableConnection::new(p.acquire().await?)),
                // A transaction of a markdown connection holds one session from its BEGIN to its end (PRT-72).
                Pool::Markdown(p) => TxInner::Markdown(p.acquire().await?),
                _ => return Err(Error::internal("a SQLite transaction on another pool")),
            }
        }
    };
    let tx = TxShared::new(db, inner, sqlite_mode);
    let mut began = false;
    for (kind, sql) in &opening {
        if let Err(error) = tx.raw(kind, sql).await {
            if began {
                // An open transaction is reverted. A connection that cannot be reverted is closed.
                return Err(match rollback(&tx).await {
                    Ok(()) => error,
                    Err(rollback) => Error::rollback_failed_of(error, rollback),
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

/// The table that the SQLite row lock uses.
pub(crate) const ROW_LOCK_TABLE: &str = "orm__row_lock";

async fn ensure_sqlite_lock_table(db: &Db) -> Result<()> {
    if db.inner.sqlite_lock_ready.load(Ordering::Acquire) {
        return Ok(());
    }
    let tables = [ROW_LOCK_TABLE.to_owned()];
    let create = "CREATE TABLE IF NOT EXISTS \"orm__row_lock\" (\"id\" INTEGER PRIMARY KEY CHECK (\"id\" = 1))";
    let sent = Sent::bare(KIND_UTILITY, &tables, None, create);
    match db.pool() {
        Pool::Sqlite(p) => events::raw(db, p, sent).await?,
        Pool::Markdown(p) => events::raw(db, &mut p.acquire().await?, sent).await?,
        _ => return Ok(()),
    }
    db.inner.sqlite_lock_ready.store(true, Ordering::Release);
    Ok(())
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
            match db.statement_done(Sent { sql: release, binds: &binds, kind: KIND_UTILITY, tables: &[], transaction: number, lock: "" }, start, r) {
                Ok(Some(1)) => {}
                Ok(_) => errors.push(Error::config(format!("lock {key} was not held at transaction end"))),
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
    if matches!(inner, TxInner::Sqlite(_) | TxInner::Markdown(_)) {
        let mode = tx.sqlite_mode.lock().unwrap().take();
        if let Some((uncommitted, read_only)) = mode {
            if read_only {
                if let Err(error) = raw_on(db, inner, Sent::bare(KIND_UTILITY, &[], number, "PRAGMA query_only = 0")).await {
                    errors.push(error);
                }
            }
            if uncommitted {
                if let Err(error) = raw_on(db, inner, Sent::bare(KIND_UTILITY, &[], number, "PRAGMA read_uncommitted = 0")).await {
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
                conn.returned().await;
            }
        }
        TxInner::Postgres(mut t) => {
            events::raw(&tx.db, &mut *t, s).await?;
            if clean {
                t.returned().await;
            }
        }
        TxInner::Sqlite(mut t) => {
            // SQLite may have rolled the transaction back by itself after an error (INT-155); then there is nothing to roll back.
            if kind != KIND_ROLLBACK || crate::db::sqlite_in_transaction(&mut t).await? {
                events::raw(&tx.db, &mut *t, s).await?;
            }
            if clean {
                t.returned().await;
            }
        }
        // A markdown session reports no autocommit state, so its ROLLBACK is always sent. A session whose end failed, or whose
        // cleanup failed, has an unknown state, so it is closed instead of returned to the pool.
        TxInner::Markdown(mut session) => {
            let ended = events::raw(&tx.db, &mut session, s).await;
            if ended.is_err() || !clean {
                session.discard();
            }
            ended?;
        }
    }
    tx.db.keep_idle_size().await;
    Ok(())
}

async fn commit(tx: &TxShared) -> Result<()> {
    let mut inner = take_inner(tx).await?;
    finish(tx, &mut inner).await?;
    end(tx, inner, KIND_COMMIT, "COMMIT", true).await
}

async fn take_inner(tx: &TxShared) -> Result<TxInner> {
    tx.finished.store(true, Ordering::Release);
    let mut guard = tx.inner.lock().await;
    guard.take().ok_or_else(|| Error::config("transaction already finished"))
}

/// After the transaction is rolled back, consumes the configured test fault: that rollback
/// is reported as failed with `FAULT` (`polyspec_orm::testing::fail_next_rollback`, feature
/// `test-faults`).
fn rollback_fault(db: &Db) -> Result<()> {
    if db.inner.rollback_fault.swap(false, Ordering::AcqRel) {
        return Err(Error::new(crate::Kind::Fault, "test fault: the rollback of the transaction ran and is reported as failed"));
    }
    Ok(())
}

async fn rollback(tx: &TxShared) -> Result<()> {
    let mut inner = take_inner(tx).await?;
    let cleanup = finish(tx, &mut inner).await;
    let rolled_back = end(tx, inner, KIND_ROLLBACK, "ROLLBACK", cleanup.is_ok()).await;
    match (cleanup, rolled_back) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(e), Ok(())) => Err(e),
        (Ok(()), Err(e)) => Err(e),
        (Err(cleanup), Err(rollback)) => Err(Error::config(format!("transaction cleanup failed ({cleanup}) and rollback failed ({rollback})"))),
    }
}

/// The retryable DEADLOCK error.
pub fn transaction_conflict(message: impl Into<String>) -> Error {
    Error::new(crate::Kind::Deadlock, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Scratch;
    use polyspec_orm_testcase::OrPanic;

    async fn probe_row_count(db: &Db) -> i64 {
        match db.pool() {
            Pool::MySql(pool) => sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM orm_once_probe").fetch_one(pool).await.unwrap(),
            Pool::Postgres(pool) => sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM orm_once_probe").fetch_one(pool).await.unwrap(),
            Pool::Sqlite(pool) => sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM orm_once_probe").fetch_one(pool).await.unwrap(),
            Pool::Markdown(_) => unreachable!("the transaction tests connect to SQL databases"),
        }
    }

    #[tokio::test]
    async fn transaction_probe_count_reads_sqlite_rows() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let scratch = Scratch::new("orm-probe-count");
        let db = Db::connect(&format!("sqlite://{}", scratch.join("probe.sqlite").display()), 1, crate::Config::default()).await.unwrap();
        let Pool::Sqlite(pool) = db.pool() else { panic!("the test database is SQLite") };
        sqlx::query("CREATE TABLE orm_once_probe (id INTEGER PRIMARY KEY)").execute(pool).await.unwrap();
        sqlx::query("INSERT INTO orm_once_probe (id) VALUES (1), (2)").execute(pool).await.unwrap();

        assert_eq!(probe_row_count(&db).await, 2);
        db.close().await;
    }

    #[test]
    fn scratch_is_removed_after_a_failed_assertion() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let path = std::sync::Mutex::new(None);
        let unwound = std::panic::catch_unwind(|| {
            let scratch = Scratch::new("orm-scratch-unwind");
            std::fs::write(scratch.join("left.sqlite"), b"x").unwrap();
            *path.lock().unwrap() = Some(scratch.path().to_path_buf());
            panic!("a failed assertion");
        });
        assert!(unwound.is_err(), "the body panicked");
        let path = path.lock().unwrap().clone().unwrap();
        assert!(!path.exists(), "{} is left after the panic", path.display());
    }

    async fn panics() -> Result<()> {
        panic!("callback panicked")
    }

    fn once() -> TransactionOptions {
        TransactionOptions { retry: Some(0), ..Default::default() }
    }

    async fn sqlite_db(tmp: &Scratch, name: &str) -> Db {
        Db::connect(&format!("sqlite://{}", tmp.join(name).display()), 1, crate::Config::default()).await.expect("connect")
    }

    // A callback that fails with deadlock, its own transaction_conflict included, runs again up to retry times; any other
    // failure is returned unchanged after one run (CORE-24, CORE-25).
    #[tokio::test]
    // Requirements: CORE-24, INT-43, INT-48.
    async fn a_deadlock_runs_the_callback_again() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let tmp = Scratch::new("orm-transaction-retry");
        let db = sqlite_db(&tmp, "retry.sqlite").await;
        let runs = &AtomicU32::new(0);
        let ended = db
            .transaction(
                |_tx: Tx| async move {
                    if runs.fetch_add(1, Ordering::SeqCst) < 2 {
                        return Err(transaction_conflict("conflict"));
                    }
                    Ok(7)
                },
                TransactionOptions::default(),
            )
            .await;
        assert!(matches!(ended, Ok(7)) && runs.load(Ordering::SeqCst) == 3, "two conflicts, then a commit: {ended:?}");
        runs.store(0, Ordering::SeqCst);
        let ended = db
            .transaction(
                |_tx: Tx| async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                    Err::<(), _>(transaction_conflict("always"))
                },
                once(),
            )
            .await;
        assert!(matches!(&ended, Err(error) if error.kind() == Kind::Deadlock && error.text() == "always"), "{ended:?}");
        assert_eq!(runs.load(Ordering::SeqCst), 1, "retry 0 runs once");
        let ended = db.transaction(|_tx: Tx| async move { Err::<(), _>(Error::config("not retried")) }, TransactionOptions::default()).await;
        assert!(matches!(&ended, Err(error) if error.kind() == Kind::Config && error.text() == "not retried"), "{ended:?}");
        db.close().await;
    }

    // A statement on a pool whose one connection a transaction holds waits up to pool_acquire_timeout_ms and fails with
    // pool_timeout (CORE-30); after close, every call is closed and a second close succeeds (CORE-31).
    #[tokio::test]
    // Requirements: CORE-30, CORE-31.
    async fn an_exhausted_pool_is_pool_timeout_and_a_closed_one_is_closed() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let tmp = Scratch::new("orm-pool-timeout");
        let config = crate::Config { pool_acquire_timeout_ms: 200, ..crate::Config::default() };
        let db = Db::connect(&format!("sqlite://{}", tmp.join("pool.sqlite").display()), 1, config).await.expect("connect");
        let other = db.clone();
        let inside = db
            .transaction(
                |_tx: Tx| {
                    let other = other.clone();
                    async move { Ok(other.transaction(|_inner: Tx| async { Ok(()) }, once()).await.err().map(|error| error.kind())) }
                },
                once(),
            )
            .await
            .expect("the outer transaction commits");
        assert_eq!(inside, Some(Kind::PoolTimeout), "the second transaction waits for the one connection");
        db.close().await;
        let after = db.transaction(|_tx: Tx| async { Ok(()) }, once()).await;
        assert!(matches!(&after, Err(error) if error.kind() == Kind::Closed), "{after:?}");
        db.close().await;
    }

    // The wait before attempt n is 50 << (n - 1) milliseconds and the jitter (CORE-24).
    #[test]
    fn the_retry_wait_doubles() {
        assert_eq!(retry_wait(1, 0), std::time::Duration::from_millis(50));
        assert_eq!(retry_wait(2, 19), std::time::Duration::from_millis(119));
        assert_eq!(retry_wait(3, 0), std::time::Duration::from_millis(200));
    }

    // A panic of the callback rolls the transaction back and is internal; it is not resumed (CORE-26).
    #[tokio::test]
    // Requirements: CORE-26.
    async fn a_panicking_callback_is_internal() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let tmp = Scratch::new("orm-transaction-panic");
        let db = sqlite_db(&tmp, "panic.sqlite").await;
        execute(&db, "CREATE TABLE orm_panic_probe (id INTEGER PRIMARY KEY)").await;
        let ended = db
            .transaction(
                |tx: Tx| async move {
                    tx.run(KIND_UTILITY, &[], "INSERT INTO orm_panic_probe (id) VALUES (1)", &[]).await?;
                    panic!("callback panicked")
                },
                once(),
            )
            .await;
        let ended: Result<()> = ended;
        assert!(matches!(&ended, Err(error) if error.kind() == Kind::Internal && error.text() == "the callback panicked: callback panicked"), "{ended:?}");
        let ended = db.transaction(|tx: Tx| async move { tx.savepoint(|_savepoint: Tx| async move { panic!("savepoint panicked") }).await }, once()).await;
        let ended: Result<()> = ended;
        assert!(matches!(&ended, Err(error) if error.kind() == Kind::Internal), "{ended:?}");
        assert_eq!(probe_row_count_of(&db, "orm_panic_probe").await, 0, "the panicked transaction rolled back");
        db.close().await;
    }

    async fn probe_row_count_of(db: &Db, table: &str) -> i64 {
        let Pool::Sqlite(pool) = db.pool() else { panic!("SQLite pool") };
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}"))).fetch_one(pool).await.expect("count")
    }

    // A savepoint whose callback fails reverts its work and returns the failure unchanged; the outer transaction keeps its own
    // work (CORE-21).
    #[tokio::test]
    // Requirements: CORE-21, INT-46.
    async fn a_failed_savepoint_reverts_only_its_work() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let tmp = Scratch::new("orm-savepoint");
        let db = sqlite_db(&tmp, "savepoint.sqlite").await;
        execute(&db, "CREATE TABLE orm_savepoint_probe (id INTEGER PRIMARY KEY)").await;
        db.transaction(
            |tx: Tx| async move {
                tx.run(KIND_UTILITY, &[], "INSERT INTO orm_savepoint_probe (id) VALUES (1)", &[]).await?;
                let inner = tx
                    .savepoint(|savepoint: Tx| async move {
                        savepoint.run(KIND_UTILITY, &[], "INSERT INTO orm_savepoint_probe (id) VALUES (2)", &[]).await?;
                        Err::<(), _>(Error::config("inner failed"))
                    })
                    .await;
                assert!(matches!(&inner, Err(error) if error.kind() == Kind::Config && error.text() == "inner failed"), "{inner:?}");
                tx.savepoint(
                    |savepoint: Tx| async move { savepoint.run(KIND_UTILITY, &[], "INSERT INTO orm_savepoint_probe (id) VALUES (3)", &[]).await.map(drop) },
                )
                .await
            },
            once(),
        )
        .await
        .expect("the outer transaction commits");
        assert_eq!(probe_row_count_of(&db, "orm_savepoint_probe").await, 2, "rows 1 and 3");
        db.close().await;
    }

    fn required_dsn(name: &str) -> String {
        match std::env::var(name) {
            Ok(dsn) if !dsn.is_empty() => dsn,
            Ok(_) => panic!("{name} is set but empty; database tests never skip"),
            Err(error) => panic!("{name} is required ({error}); database tests never skip"),
        }
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

    #[tokio::test]
    // Requirements: INT-72.
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
        db.transaction(|tx: Tx| async move { tx.utils().lock(&format!("orm_test.clean.{}", std::process::id())).await }, once())
            .await
            .expect("a clean transaction");
        assert_eq!(session().await, clean, "a transaction that ended cleanly keeps its session");
        for fail in [true, false] {
            let before = session().await;
            let key = format!("orm_test.discard.{fail}.{}", std::process::id());
            let key = &key;
            let result = db
                .transaction(
                    |tx: Tx| async move {
                        tx.utils().lock(key).await?;
                        // If the lock is released early, RELEASE_LOCK at the end of the transaction returns 0, and the cleanup fails.
                        tx.run(KIND_UTILITY, &[], &format!("DO RELEASE_LOCK('{key}')"), &[]).await?;
                        if fail {
                            return Err(Error::config("callback failed"));
                        }
                        Ok(())
                    },
                    once(),
                )
                .await;
            assert!(result.is_err(), "the failed cleanup is reported");
            let path = if fail { "rollback" } else { "commit" };
            assert_ne!(session().await, before, "{path}: session {before} returned to the pool after its cleanup failed");
        }
        db.close().await;
    }

    /// Opens a MySQL transaction, sets a local value, then kills that connection from another connection.
    /// The real server does not reject `SET @`orm.…` = NULL`, so the reset is made to fail with the killed connection.
    /// Since this test kills a server session, db connects to the server at ORM_TEST_MYSQL_SERVER_DSN, not through a pooler,
    /// because ProxySQL takes KILL as a command for its own client session.
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

    // Even if RELEASE_LOCK fails, the local value reset is still attempted, and both failures are reported.
    #[tokio::test]
    // Requirements: INT-72.
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
    // Requirements: INT-72.
    async fn panicking_callback_ends_its_transaction() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let db = Db::connect(&required_dsn("ORM_TEST_MYSQL_DSN"), 2, crate::Config::default()).await.expect("connect");
        let key = format!("orm_test.panicked.{}", std::process::id());
        let key_ref = &key;
        let panicked: Result<()> = db
            .transaction(
                |tx: Tx| async move {
                    tx.utils().lock(key_ref).await?;
                    panic!("callback panicked")
                },
                once(),
            )
            .await;
        assert!(matches!(&panicked, Err(error) if error.kind() == Kind::Internal), "the callback panics: {panicked:?}");
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
    // transaction and lock, so another connection takes the lock. The MySQL connection uses TLS, through the ssl-mode of
    // ORM_TEST_MYSQL_TLS_DSN (a DSN without ssl-mode connects without TLS, CFG-44), since sqlx's TLS stream shutdown
    // waits for data the server does not send. This test watches the end of a server session, so it connects to the
    // servers at ORM_TEST_MYSQL_TLS_DSN and ORM_TEST_POSTGRES_SERVER_DSN, not through a pooler.
    // On SQLite, the write transaction of the closed connection ends, so another connection takes the write lock.
    #[tokio::test]
    // Requirements: INT-72, INT-67.
    async fn dropped_transaction_closes_its_connection() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let tmp = Scratch::new("orm-dropped");
        let targets = [
            ("sqlite", format!("sqlite://{}", tmp.join("dropped.sqlite").display())),
            ("mysql", required_dsn("ORM_TEST_MYSQL_TLS_DSN")),
            ("postgres", required_dsn("ORM_TEST_POSTGRES_SERVER_DSN")),
        ];
        for (driver, dsn) in targets {
            let db = Db::connect(&dsn, 2, crate::Config::default()).await.or_panic(|e| format!("{driver}: {e}"));
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
            let (key_ref, held_ref) = (&key, &held);
            let transaction = db.transaction(
                |tx: Tx| async move {
                    tx.utils().lock(key_ref).await?;
                    if driver == "sqlite" {
                        tx.run(KIND_UTILITY, &[], "INSERT INTO orm_dropped_probe (id) VALUES (1)", &[]).await?;
                    }
                    held_ref.notify_one();
                    std::future::pending::<()>().await;
                    Ok::<(), Error>(())
                },
                once(),
            );
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
        let text = |p: *const std::ffi::c_char| {
            if p.is_null() {
                ""
            } else {
                unsafe { std::ffi::CStr::from_ptr(p) }.to_str().or_panic(|e| format!("the SQLite text is not UTF-8: {e}"))
            }
        };
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
    // Requirements: INT-72.
    async fn sqlite_transaction_end_failures_are_reported() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let _denial = SQLITE_DENIAL.lock().await;
        let tmp = Scratch::new("orm-transaction-end");
        let db = Db::connect(&format!("sqlite://{}", tmp.join("end.sqlite").display()), 1, crate::Config::default()).await.expect("connect");
        let both = |error: &Error, cause: &str| {
            let text = error.to_string();
            assert!(text.starts_with("rollback_failed: the rollback failed after the callback failed: ") && text.contains("not authorized"), "{text}");
            // The rollback_failed error holds the callback error and the rollback error (CORE-25).
            match (error.callback_error(), error.rollback_error()) {
                (Some(crate::CallbackFailure::Kind(callback)), Some(rollback)) => {
                    assert_eq!(callback.to_string(), cause, "callback error");
                    assert!(rollback.to_string().contains("not authorized"), "rollback error: {rollback}");
                }
                other => panic!("rollback_failed expected: {other:?}"),
            }
        };
        deny_on_sqlite(&db, DENY_ROLLBACK).await;
        let read_only = || TransactionOptions { read_only: Some(true), ..once() };
        let error = db.transaction(|_tx: Tx| async { Err::<(), _>(Error::config("callback failed")) }, once()).await.expect_err("rollback");
        both(&error, "config: callback failed");
        deny_on_sqlite(&db, DENY_ROLLBACK).await;
        let error = db.transaction(|_tx: Tx| panics(), once()).await.expect_err("the callback panics");
        both(&error, "internal: the callback panicked: callback panicked");
        deny_on_sqlite(&db, DENY_QUERY_ONLY_ON).await;
        let error = db.transaction(|_tx: Tx| async { Ok(()) }, read_only()).await.expect_err("begin");
        assert!(error.to_string().contains("not authorized"), "begin: {error}");
        SQLITE_DENIED.store(DENY_NOTHING, Ordering::Release);
        db.transaction(|_tx: Tx| async { Ok(()) }, once()).await.expect("a transaction after the failed begin");
        deny_on_sqlite(&db, DENY_QUERY_ONLY_OFF).await;
        let error = db.transaction(|_tx: Tx| async { Ok(()) }, read_only()).await.expect_err("commit");
        assert!(error.to_string().contains("not authorized"), "commit: {error}");
        deny_on_sqlite(&db, DENY_QUERY_ONLY_OFF).await;
        let error = db.transaction(|_tx: Tx| async { Err::<(), _>(Error::config("callback failed")) }, read_only()).await.expect_err("mode reset");
        both(&error, "config: callback failed");
        SQLITE_DENIED.store(DENY_NOTHING, Ordering::Release);
        db.close().await;
    }

    // If ROLLBACK TO SAVEPOINT or RELEASE SAVEPOINT, which end a savepoint, fails, the failure of the callback, a panic
    // included, and that error are reported together as rollback_failed, and a successful callback returns the failed RELEASE
    // SAVEPOINT (CORE-21, CORE-25).
    #[tokio::test]
    // Requirements: DIA-181, PLN-17.
    async fn savepoint_end_failures_are_reported() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
        let _denial = SQLITE_DENIAL.lock().await;
        let tmp = Scratch::new("orm-savepoint-end");
        let db = Db::connect(&format!("sqlite://{}", tmp.join("savepoint.sqlite").display()), 1, crate::Config::default()).await.expect("connect");
        let both = |what: &str, text: &str| {
            assert!(text.starts_with("rollback_failed: the rollback failed after the callback failed") && text.contains("not authorized"), "{what}: {text}");
        };
        for denied in [DENY_SAVEPOINT_ROLLBACK, DENY_SAVEPOINT_RELEASE, DENY_SAVEPOINT_END] {
            deny_on_sqlite(&db, denied).await;
            let error = db
                .transaction(|tx: Tx| async move { tx.savepoint(|_savepoint: Tx| async { Err::<(), _>(Error::config("callback failed")) }).await }, once())
                .await
                .expect_err("callback error");
            both(&format!("callback error {denied}"), &error.to_string());
            if denied == DENY_SAVEPOINT_END {
                assert_eq!(error.to_string().matches("not authorized").count(), 2, "both savepoint statements are reported: {error}");
            }
            let error = db.transaction(|tx: Tx| async move { tx.savepoint(|_savepoint: Tx| panics()).await }, once()).await.expect_err("the callback panics");
            assert!(
                error.kind() == Kind::RollbackFailed
                    && matches!(error.callback_error(), Some(crate::CallbackFailure::Kind(callback)) if callback.kind() == Kind::Internal),
                "panic {denied}: {error}"
            );
        }
        deny_on_sqlite(&db, DENY_SAVEPOINT_RELEASE).await;
        let error = db.transaction(|tx: Tx| async move { tx.savepoint(|_savepoint: Tx| async { Ok(()) }).await }, once()).await.expect_err("release");
        assert!(error.to_string().contains("not authorized"), "release: {error}");
        SQLITE_DENIED.store(DENY_NOTHING, Ordering::Release);
        db.close().await;
    }

    // If the MySQL local value reset at the end of the transaction fails, that error is reported. The MySQL user
    // variable remains after COMMIT and ROLLBACK (mysql.context.user_variable_session_scope).
    #[tokio::test]
    // Requirements: INT-72.
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
