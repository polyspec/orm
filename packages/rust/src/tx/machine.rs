//! The state machines of `Db::transaction`, `Tx::savepoint` and `Db::close` (docs/spec/core.md CORE-100 to CORE-105).
//! A machine makes no I/O itself: each step is a future of the core that touches no language code, a call of the
//! callback on the thread that drives the machine, a value of the callback that the driver awaits and settles, or the
//! result of the member (CORE-27).

use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

use binding_core::machine::{Machine, Step};
use binding_core::{Failure, Passthrough, Raised};

use super::{
    audit_record, await_hook, begin, call_hook, commit, lock, panicked, rollback, rollback_fault, rollback_savepoint, AuditInsert, AuditKey, Isolation,
    TransactionOptions, Tx, TxShared, DEFAULT_RETRY,
};
use crate::db::TransactionHook;
use crate::events::{KIND_RELEASE, KIND_SAVEPOINT};
use crate::{Db, Error, Kind, Result};

/// What the callback of a machine returned, and what a machine of a callback ends with (CORE-102).
type Outcome = std::result::Result<Passthrough, Failure<Error>>;

/// Where a machine of a callback stands between two steps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    /// Nothing is sent.
    Start,
    /// The driver calls the audit source before the first `BEGIN` (CORE-131).
    Source,
    /// The driver calls a hook before the transaction (CORE-143).
    Hook,
    /// The future of a hook of Rust code is awaited (CORE-143).
    Hooking,
    /// The opening is awaited.
    Opening,
    /// The driver calls the callback.
    Call,
    /// The driver settles the value of the callback.
    Settle,
    /// The end after a value is awaited: `COMMIT` or `RELEASE SAVEPOINT`.
    Keeping,
    /// The end after a failure is awaited: the rollback.
    Reverting,
    /// The machine gave its result.
    Ended,
}

/// The step after the callback of a transaction or a savepoint: its value is awaited in the stage Settle; otherwise the
/// failure of the callback to revert, or None when the callback gave no outcome.
fn after_call<I>(called: Option<Outcome>, stage: &mut Stage) -> std::result::Result<Step<I, Outcome>, Option<Failure<Error>>> {
    match called {
        Some(Ok(value)) => {
            *stage = Stage::Settle;
            Ok(Step::Await(value))
        }
        Some(Err(failure)) => Err(Some(failure)),
        None => Err(None),
    }
}

/// The `internal` failure of a driver that gave a machine a step out of its order.
fn out_of_order(what: &str, stage: Stage) -> Failure<Error> {
    Failure::Kind(Error::internal(format!("the machine of {what} was advanced out of order at {stage:?}")))
}

/// Calls `callback` with `handle`; a panic of the callback is the error `internal` (CORE-26).
fn call_back<F>(callback: &mut F, handle: Tx) -> (Outcome, bool)
where
    F: FnMut(Tx) -> Outcome,
{
    match std::panic::catch_unwind(AssertUnwindSafe(|| callback(handle))) {
        Ok(outcome) => (outcome, false),
        Err(payload) => (Err(Failure::Kind(panicked(payload))), true),
    }
}

/// The output of an I/O step of [`Transaction`].
pub struct TransactionIo(TransactionOutput);

enum TransactionOutput {
    Hooked(Result<()>),
    Opened(Result<Arc<TxShared>>),
    Ended(Result<()>),
}

/// The state machine of `Db::transaction` (CORE-103, CORE-104), which owns its callback and its options.
pub struct Transaction<F> {
    db: Db,
    callback: F,
    isolation: Option<Isolation>,
    read_only: bool,
    timeout_ms: Option<u64>,
    retry: u32,
    /// The audit values of the options until the step `Source` reads the audit source.
    audit: Option<super::AuditMap>,
    /// The audit record that the call of the source made, until the machine reads it.
    sourced: Option<std::result::Result<AuditInsert, Failure<Error>>>,
    record: Option<Arc<AuditInsert>>,
    /// The hooks of the attempt that are not called yet, in the order of their registration (CORE-143).
    hooks: std::vec::IntoIter<Arc<TransactionHook>>,
    /// The hook that the driver calls in the step `Hook`.
    hook: Option<Arc<TransactionHook>>,
    /// What the call of that hook returned, until the machine reads it.
    hooked: Option<std::result::Result<(), Failure<Error>>>,
    attempt: u32,
    stage: Stage,
    shared: Option<Arc<TxShared>>,
    handle: Option<Tx>,
    called: Option<Outcome>,
    settled: Option<Outcome>,
    /// The value of the callback while its `COMMIT` is awaited.
    value: Option<Passthrough>,
    /// The failure of the callback while its rollback is awaited.
    failure: Option<Failure<Error>>,
    /// Whether the callback of this attempt panicked: such an attempt is not run again (CORE-26).
    panicked: bool,
    /// The errors of the earlier attempts that a deadlock retry ran again, in order (CORE-24); the last error carries them.
    earlier: Vec<Error>,
}

impl<F> Transaction<F> {
    pub(super) fn new(db: Db, callback: F, options: TransactionOptions) -> Self {
        let TransactionOptions { isolation, read_only, timeout_ms, retry, audit } = options;
        Self {
            db,
            callback,
            isolation,
            read_only: read_only == Some(true),
            // An absent or zero bound sets none (INT-42).
            timeout_ms: timeout_ms.filter(|ms| *ms > 0),
            retry: retry.unwrap_or(DEFAULT_RETRY),
            audit,
            sourced: None,
            earlier: Vec::new(),
            record: None,
            hooks: Vec::new().into_iter(),
            hook: None,
            hooked: None,
            attempt: 0,
            stage: Stage::Start,
            shared: None,
            handle: None,
            called: None,
            settled: None,
            value: None,
            failure: None,
            panicked: false,
        }
    }

    fn end(&mut self, outcome: Outcome) -> Step<TransactionIo, Outcome> {
        self.stage = Stage::Ended;
        if let Some(handle) = self.handle.take() {
            handle.open.store(false, Ordering::Release);
        }
        if let Some(shared) = self.shared.take() {
            if !shared.finished.load(Ordering::Acquire) {
                shared.abort();
            }
        }
        Step::Done(outcome)
    }

    /// Starts an attempt: reads the hooks registered at this moment (CORE-143) and calls them before the opening.
    fn start_attempt(&mut self) -> Step<TransactionIo, Outcome> {
        match self.db.transaction_hooks() {
            Ok(hooks) => {
                self.hooks = hooks.into_iter();
                self.next_hook()
            }
            Err(error) => self.end(Err(Failure::Kind(error))),
        }
    }

    /// Calls the next hook of the attempt, each after the one before it ended, and opens the transaction after the last:
    /// a hook of a binding in a step `Call`, on the thread that drives the machine, and a hook of Rust code in a step
    /// `Io` that awaits its future (CORE-143).
    fn next_hook(&mut self) -> Step<TransactionIo, Outcome> {
        let Some(hook) = self.hooks.next() else {
            return self.open();
        };
        if matches!(*hook, TransactionHook::Call(_)) {
            self.hook = Some(hook);
            self.stage = Stage::Hook;
            return Step::Call;
        }
        self.stage = Stage::Hooking;
        let read_only = self.read_only;
        Step::Io(Box::pin(async move { TransactionIo(TransactionOutput::Hooked(await_hook(&hook, read_only).await)) }))
    }

    /// A hook failed: the transaction ends before it begins, with that failure unchanged and without another attempt
    /// (CORE-143).
    fn refuse(&mut self, failure: Failure<Error>) -> Step<TransactionIo, Outcome> {
        self.hooks = Vec::new().into_iter();
        self.end(Err(failure))
    }

    /// Step 1: borrows a connection and sends `BEGIN` with the options.
    fn open(&mut self) -> Step<TransactionIo, Outcome> {
        self.stage = Stage::Opening;
        self.handle = None;
        self.shared = None;
        self.panicked = false;
        let (db, isolation, read_only, timeout_ms) = (self.db.clone(), self.isolation, self.read_only, self.timeout_ms);
        Step::Io(Box::pin(async move { TransactionIo(TransactionOutput::Opened(begin(&db, isolation, read_only, timeout_ms).await.map(Arc::new))) }))
    }

    /// Ends the handle of the callback (CORE-23) and gives the transaction of the attempt.
    fn close_handle(&mut self) -> Option<Arc<TxShared>> {
        if let Some(handle) = self.handle.take() {
            handle.open.store(false, Ordering::Release);
        }
        self.shared.clone()
    }

    /// Step 4 after a failure: sends `ROLLBACK` and keeps the failure for the result.
    fn revert(&mut self, failure: Failure<Error>) -> Step<TransactionIo, Outcome> {
        let Some(shared) = self.close_handle() else {
            return self.end(Err(out_of_order("a transaction", self.stage)));
        };
        self.failure = Some(failure);
        self.stage = Stage::Reverting;
        let (db, fault) = (self.db.clone(), !self.panicked);
        Step::Io(Box::pin(async move {
            let rolled_back = rollback(&shared).await;
            TransactionIo(TransactionOutput::Ended(if fault { rolled_back.and_then(|()| rollback_fault(&db)) } else { rolled_back }))
        }))
    }

    /// Runs the attempt again, with no wait, when `failure` has the kind `deadlock` (CORE-24), and ends with it otherwise. A raised exception has no kind for the core, so it is not run again (CORE-104).
    fn again_or_end(&mut self, failure: Failure<Error>) -> Step<TransactionIo, Outcome> {
        let deadlock = matches!(&failure, Failure::Kind(error) if error.is_deadlock());
        if !deadlock || self.panicked || self.attempt >= self.retry {
            // The last attempt carries the errors of the attempts before it when it failed with deadlock (CORE-24).
            let failure = match failure {
                Failure::Kind(error) if deadlock => Failure::Kind(error.with_attempts(std::mem::take(&mut self.earlier))),
                other => other,
            };
            return self.end(Err(failure));
        }
        if let Failure::Kind(error) = failure {
            self.earlier.push(error);
        }
        // The next attempt begins right after the rollback, with no wait between attempts (CORE-24).
        self.attempt += 1;
        self.start_attempt()
    }
}

impl<F> Drop for Transaction<F> {
    fn drop(&mut self) {
        if let Some(shared) = self.close_handle() {
            shared.abort();
        }
    }
}

impl<F> Machine for Transaction<F>
where
    F: FnMut(Tx) -> Outcome,
{
    type Io = TransactionIo;
    type Done = Outcome;

    fn resume(&mut self, io: Option<TransactionIo>) -> Step<TransactionIo, Outcome> {
        match (self.stage, io.map(|io| io.0)) {
            (Stage::Start, None) => {
                // The audit source is called once, before the transaction starts, on the thread that drives the
                // machine, because a source of a language may be called only there (CORE-131).
                if self.audit.is_some() {
                    self.stage = Stage::Source;
                    return Step::Call;
                }
                self.start_attempt()
            }
            (Stage::Source, None) => match self.sourced.take() {
                Some(Ok(record)) => {
                    self.record = Some(Arc::new(record));
                    self.start_attempt()
                }
                Some(Err(failure)) => self.end(Err(failure)),
                None => self.end(Err(out_of_order("a transaction", Stage::Source))),
            },
            (Stage::Hook, None) => match self.hooked.take() {
                Some(Ok(())) => self.next_hook(),
                Some(Err(failure)) => self.refuse(failure),
                None => self.end(Err(out_of_order("a transaction", Stage::Hook))),
            },
            (Stage::Hooking, Some(TransactionOutput::Hooked(Ok(())))) => self.next_hook(),
            (Stage::Hooking, Some(TransactionOutput::Hooked(Err(error)))) => self.refuse(Failure::Kind(error)),
            (Stage::Opening, Some(TransactionOutput::Opened(Ok(shared)))) => {
                // Each attempt starts with the pending record and no inserted audit.
                match lock(&shared.pending_audit) {
                    Ok(mut pending) => *pending = self.record.clone(),
                    Err(error) => return self.end(Err(Failure::Kind(error))),
                }
                self.handle = Some(Tx::new(Arc::clone(&shared), 0));
                self.shared = Some(shared);
                self.stage = Stage::Call;
                Step::Call
            }
            (Stage::Opening, Some(TransactionOutput::Opened(Err(error)))) => self.end(Err(Failure::Kind(error))),
            (Stage::Call, None) => match after_call(self.called.take(), &mut self.stage) {
                Ok(step) => step,
                Err(Some(failure)) => self.revert(failure),
                Err(None) => self.end(Err(out_of_order("a transaction", Stage::Call))),
            },
            (Stage::Settle, None) => match self.settled.take() {
                Some(Ok(value)) => {
                    let Some(shared) = self.close_handle() else {
                        return self.end(Err(out_of_order("a transaction", Stage::Settle)));
                    };
                    self.value = Some(value);
                    self.stage = Stage::Keeping;
                    Step::Io(Box::pin(async move { TransactionIo(TransactionOutput::Ended(commit(&shared).await)) }))
                }
                Some(Err(failure)) => self.revert(failure),
                None => self.end(Err(out_of_order("a transaction", Stage::Settle))),
            },
            (Stage::Keeping, Some(TransactionOutput::Ended(ended))) => match (ended, self.value.take()) {
                (Ok(()), Some(value)) => self.end(Ok(value)),
                (Ok(()), None) => self.end(Err(out_of_order("a transaction", Stage::Keeping))),
                // A deadlocked commit is run again as a deadlocked callback is, and the value of the attempt is dropped
                // (CORE-104); any other commit error, such as write_conflict, is returned at once.
                (Err(error), _) => self.again_or_end(Failure::Kind(error)),
            },
            (Stage::Reverting, Some(TransactionOutput::Ended(ended))) => match (ended, self.failure.take()) {
                (Ok(()), Some(failure)) => self.again_or_end(failure),
                (Err(rollback), Some(failure)) => self.end(Err(Failure::Kind(Error::rollback_failed(failure, rollback)))),
                (_, None) => self.end(Err(out_of_order("a transaction", Stage::Reverting))),
            },
            (stage, _) => self.end(Err(out_of_order("a transaction", stage))),
        }
    }

    fn call(&mut self) {
        if self.stage == Stage::Source {
            if let Some(values) = self.audit.take() {
                // A panic of the source is the error `internal`, as a panic of the callback is (CORE-26).
                let db = &self.db;
                self.sourced = Some(match std::panic::catch_unwind(AssertUnwindSafe(|| audit_record(db, &values))) {
                    Ok(sourced) => sourced,
                    Err(payload) => Err(Failure::Kind(panicked(payload))),
                });
            }
            return;
        }
        if self.stage == Stage::Hook {
            // A hook of a binding is language code, which is called on the thread that drives the machine (CORE-143).
            if let Some(hook) = self.hook.take() {
                if let TransactionHook::Call(call) = &*hook {
                    self.hooked = Some(call_hook(call, self.read_only));
                }
            }
            return;
        }
        if self.stage != Stage::Call {
            return;
        }
        if let Some(handle) = self.handle.clone() {
            let (outcome, panicked) = call_back(&mut self.callback, handle);
            self.called = Some(outcome);
            self.panicked = panicked;
        }
    }

    fn settle(&mut self, outcome: std::result::Result<Passthrough, Raised>) {
        self.settled = Some(outcome.map_err(Failure::Raised));
    }
}

/// What a savepoint restores when it does not release: the audit record and the inserted keys of the transaction as
/// they were before it.
struct Before {
    audit: Option<AuditKey>,
    inserted: HashMap<String, HashSet<i64>>,
}

impl Before {
    /// Gives the transaction the audit record and the inserted keys that it had before the savepoint.
    fn restore(self, shared: &TxShared) -> Result<()> {
        *lock(&shared.audit)? = self.audit;
        *lock(&shared.inserted)? = self.inserted;
        Ok(())
    }
}

/// The output of an I/O step of [`Savepoint`].
pub struct SavepointIo(SavepointOutput);

enum SavepointOutput {
    Opened(Result<Before>),
    Released(Result<()>),
    Reverted(Result<()>),
}

/// Ownership of a savepoint opening shared by the machine and its current I/O future (CORE-7).
#[derive(Clone, Copy)]
enum SavepointState {
    Waiting,
    Open,
    Ended,
    Cancelled,
}

/// The state machine of `Tx::savepoint` (CORE-103), which owns its callback.
pub struct Savepoint<F> {
    parent: Tx,
    callback: F,
    stage: Stage,
    before: Option<Before>,
    handle: Option<Tx>,
    called: Option<Outcome>,
    settled: Option<Outcome>,
    /// The value of the callback while its `RELEASE SAVEPOINT` is awaited.
    value: Option<Passthrough>,
    /// The failure of the callback, or of the release, while the rollback is awaited.
    failure: Option<Failure<Error>>,
    /// Shared with the opening future so Drop knows whether it acquired the savepoint before the next advance.
    ownership: Arc<AtomicU8>,
}

impl<F> Savepoint<F> {
    pub(super) fn new(parent: Tx, callback: F) -> Self {
        Self {
            parent,
            callback,
            stage: Stage::Start,
            before: None,
            handle: None,
            called: None,
            settled: None,
            value: None,
            failure: None,
            ownership: Arc::new(AtomicU8::new(SavepointState::Waiting as u8)),
        }
    }

    fn depth(&self) -> u32 {
        self.parent.depth + 1
    }

    fn name(&self) -> String {
        format!("orm_sp_{}", self.depth())
    }

    fn end(&mut self, outcome: Outcome) -> Step<SavepointIo, Outcome> {
        self.stage = Stage::Ended;
        self.close_handle();
        if self.ownership.swap(SavepointState::Cancelled as u8, Ordering::AcqRel) == SavepointState::Open as u8 {
            self.parent.shared.abort();
        }
        Step::Done(outcome)
    }

    /// Ends after the savepoint was opened: the statements of the parent handle run again (CORE-22).
    fn end_opened(&mut self, outcome: Outcome) -> Step<SavepointIo, Outcome> {
        self.ownership.store(SavepointState::Ended as u8, Ordering::Release);
        self.parent.shared.running.store(self.parent.depth, Ordering::Release);
        self.end(outcome)
    }

    /// Ends the handle of the callback (CORE-23).
    fn close_handle(&mut self) {
        if let Some(handle) = self.handle.take() {
            handle.open.store(false, Ordering::Release);
        }
    }

    /// Step 4 after a failure: restores the audit state, sends `ROLLBACK TO SAVEPOINT` and `RELEASE SAVEPOINT`, and
    /// keeps the failure for the result.
    fn revert(&mut self, failure: Failure<Error>) -> Step<SavepointIo, Outcome> {
        self.close_handle();
        if self.parent.shared.aborted.load(Ordering::SeqCst) {
            return self.end_opened(Err(failure));
        }
        let Some(before) = self.before.take() else {
            return self.end_opened(Err(out_of_order("a savepoint", self.stage)));
        };
        self.failure = Some(failure);
        self.stage = Stage::Reverting;
        let (shared, name) = (Arc::clone(&self.parent.shared), self.name());
        Step::Io(Box::pin(async move {
            SavepointIo(SavepointOutput::Reverted(match before.restore(&shared) {
                Ok(()) => rollback_savepoint(&shared, &name).await,
                Err(error) => Err(error),
            }))
        }))
    }
}

impl<F> Machine for Savepoint<F>
where
    F: FnMut(Tx) -> Outcome,
{
    type Io = SavepointIo;
    type Done = Outcome;

    fn resume(&mut self, io: Option<SavepointIo>) -> Step<SavepointIo, Outcome> {
        match (self.stage, io.map(|io| io.0)) {
            (Stage::Start, None) => {
                self.stage = Stage::Opening;
                let (parent, depth, name) = (self.parent.clone(), self.depth(), self.name());
                let ownership = Arc::clone(&self.ownership);
                Step::Io(Box::pin(async move {
                    if ownership.load(Ordering::Acquire) == SavepointState::Cancelled as u8 {
                        return SavepointIo(SavepointOutput::Opened(Err(super::aborted_transaction())));
                    }
                    // The check of CORE-22 and CORE-23, then one atomic change of the state of the transaction.
                    if let Err(error) = parent.check() {
                        return SavepointIo(SavepointOutput::Opened(Err(error)));
                    }
                    let shared = &parent.shared;
                    if shared.running.compare_exchange(parent.depth, depth, Ordering::AcqRel, Ordering::Acquire).is_err() {
                        let busy = Error::new(Kind::Busy, "a savepoint callback of the transaction handle is running");
                        return SavepointIo(SavepointOutput::Opened(Err(busy)));
                    }
                    // Drop and admission use one atomic state: a retained opening cannot acquire a savepoint after
                    // its owner cancelled it, and cancellation after admission invalidates the transaction.
                    if ownership.compare_exchange(SavepointState::Waiting as u8, SavepointState::Open as u8, Ordering::AcqRel, Ordering::Acquire).is_err() {
                        shared.running.store(parent.depth, Ordering::Release);
                        return SavepointIo(SavepointOutput::Opened(Err(super::aborted_transaction())));
                    }
                    // A savepoint that does not release undoes an audit record inserted inside it.
                    let audit = shared.audit();
                    let opened = match lock(&shared.inserted).map(|inserted| inserted.clone()) {
                        Ok(inserted) => shared.savepoint_step(KIND_SAVEPOINT, &name).await.map(|()| Before { audit, inserted }),
                        Err(error) => Err(error),
                    };
                    if opened.is_err() {
                        shared.running.store(parent.depth, Ordering::Release);
                        ownership.store(SavepointState::Ended as u8, Ordering::Release);
                    }
                    SavepointIo(SavepointOutput::Opened(opened))
                }))
            }
            (Stage::Opening, Some(SavepointOutput::Opened(Ok(before)))) => {
                self.before = Some(before);
                self.handle = Some(Tx::new(Arc::clone(&self.parent.shared), self.depth()));
                self.stage = Stage::Call;
                Step::Call
            }
            (Stage::Opening, Some(SavepointOutput::Opened(Err(error)))) => self.end(Err(Failure::Kind(error))),
            (Stage::Call, None) => match after_call(self.called.take(), &mut self.stage) {
                Ok(step) => step,
                Err(Some(failure)) => self.revert(failure),
                Err(None) => self.end_opened(Err(out_of_order("a savepoint", Stage::Call))),
            },
            (Stage::Settle, None) => match self.settled.take() {
                Some(Ok(value)) => {
                    self.close_handle();
                    self.value = Some(value);
                    self.stage = Stage::Keeping;
                    let (shared, name) = (Arc::clone(&self.parent.shared), self.name());
                    Step::Io(Box::pin(async move { SavepointIo(SavepointOutput::Released(shared.savepoint_step(KIND_RELEASE, &name).await)) }))
                }
                Some(Err(failure)) => self.revert(failure),
                None => self.end_opened(Err(out_of_order("a savepoint", Stage::Settle))),
            },
            (Stage::Keeping, Some(SavepointOutput::Released(released))) => match (released, self.value.take()) {
                (Ok(()), Some(value)) => self.end_opened(Ok(value)),
                (Ok(()), None) => self.end_opened(Err(out_of_order("a savepoint", Stage::Keeping))),
                // A release that fails after a successful callback is that failure, after the rollback (CORE-21).
                (Err(error), _) => self.revert(Failure::Kind(error)),
            },
            (Stage::Reverting, Some(SavepointOutput::Reverted(reverted))) => match (reverted, self.failure.take()) {
                (Ok(()), Some(failure)) => self.end_opened(Err(failure)),
                (Err(rollback), Some(failure)) => self.end_opened(Err(Failure::Kind(Error::rollback_failed(failure, rollback)))),
                (_, None) => self.end_opened(Err(out_of_order("a savepoint", Stage::Reverting))),
            },
            (stage, _) => self.end(Err(out_of_order("a savepoint", stage))),
        }
    }

    fn call(&mut self) {
        if self.stage != Stage::Call {
            return;
        }
        if let Some(handle) = self.handle.clone() {
            self.called = Some(call_back(&mut self.callback, handle).0);
        }
    }

    fn settle(&mut self, outcome: std::result::Result<Passthrough, Raised>) {
        self.settled = Some(outcome.map_err(Failure::Raised));
    }
}

impl<F> Drop for Savepoint<F> {
    fn drop(&mut self) {
        self.close_handle();
        if self.ownership.swap(SavepointState::Cancelled as u8, Ordering::AcqRel) == SavepointState::Open as u8 {
            self.parent.shared.abort();
        }
    }
}

/// The state machine of `Db::close` (CORE-105): one I/O step, the close of the pool, and no call of language code.
pub struct Close {
    db: Option<Db>,
    closing: bool,
}

impl Close {
    pub(crate) fn new(db: Db) -> Self {
        Self { db: Some(db), closing: false }
    }
}

impl Machine for Close {
    type Io = ();
    type Done = Result<()>;

    fn resume(&mut self, io: Option<()>) -> Step<(), Result<()>> {
        match (self.db.take(), io, self.closing) {
            (Some(db), None, false) => {
                self.closing = true;
                Step::Io(Box::pin(async move { db.close_async().await }))
            }
            (None, Some(()), true) => {
                self.closing = false;
                Step::Done(Ok(()))
            }
            _ => Step::Done(Err(Error::internal("the machine of a close was advanced out of order"))),
        }
    }

    fn call(&mut self) {}

    fn settle(&mut self, _outcome: std::result::Result<Passthrough, Raised>) {}
}
