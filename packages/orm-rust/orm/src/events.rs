//! Statement events (docs/usage.md, "Statement events"): every statement the
//! connection sends publishes one event to the subscribers registered on it.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::{Duration, Instant};

use crate::db::{Db, DbInner};
use crate::value::Param;
use crate::{Error, Result};

/// A statement of a model plan that reads rows.
pub const KIND_SELECT: &str = "select";
/// A statement of a model plan that inserts rows.
pub const KIND_INSERT: &str = "insert";
/// A statement of a model plan that updates rows; a soft delete is one.
pub const KIND_UPDATE: &str = "update";
/// A statement of a model plan that deletes rows.
pub const KIND_DELETE: &str = "delete";
/// The statement that begins a transaction.
pub const KIND_BEGIN: &str = "begin";
/// The statement that commits a transaction.
pub const KIND_COMMIT: &str = "commit";
/// The statement that rolls a transaction back.
pub const KIND_ROLLBACK: &str = "rollback";
/// The statement that creates a savepoint.
pub const KIND_SAVEPOINT: &str = "savepoint";
/// The statement that releases a savepoint.
pub const KIND_RELEASE: &str = "release";
/// The statement that rolls back to a savepoint.
pub const KIND_ROLLBACK_TO: &str = "rollback_to";
/// A statement of a schema utility: catalog reads, install and
/// add_tables_and_columns, and the reads of exists, installed and empty.
pub const KIND_SCHEMA: &str = "schema";
/// Every other statement the client sends.
pub const KIND_UTILITY: &str = "utility";

/// One statement that the connection sent to the database.
#[derive(Debug, Clone, Copy)]
pub struct StatementEvent<'a> {
    /// The statement as sent; a relation step carries its expanded `IN` list.
    pub sql: &'a str,
    /// The bound values in order; a secret is `$SECRET` and an executor clock
    /// value `$NOW`.
    pub binds: &'a [Param],
    /// The kind of the statement by its origin (the `KIND_*` constants).
    pub kind: &'a str,
    /// The tables the statement names, sorted and without duplicates.
    pub tables: &'a [String],
    /// The time from sending the statement until the client read its result.
    pub elapsed: Duration,
    /// The number of the transaction of the connection that the statement ran
    /// in, counted from 1 by every outermost begin; `None` outside a
    /// transaction.
    pub transaction: Option<u64>,
    /// The error the statement ended with.
    pub error: Option<&'a Error>,
}

/// The error a subscriber returns. It fails the operation with SUBSCRIBER.
pub type SubscriberError = Box<dyn std::error::Error + Send + Sync>;

/// A statement event subscriber: a function of the event that returns `Ok(())`
/// or the error that fails the operation with SUBSCRIBER. Every such closure
/// implements it.
pub trait StatementSubscriber: Fn(&StatementEvent<'_>) -> std::result::Result<(), SubscriberError> + Send + Sync + 'static {}

impl<F> StatementSubscriber for F where F: Fn(&StatementEvent<'_>) -> std::result::Result<(), SubscriberError> + Send + Sync + 'static {}

type Subscriber = Arc<dyn Fn(&StatementEvent<'_>) -> std::result::Result<(), SubscriberError> + Send + Sync>;

/// 연결의 모든 handle이 공유하는 subscriber 목록과 transaction 번호다. 목록은 바꿀 때마다
/// 새로 만들므로 publish는 읽은 목록을 lock 없이 쓴다.
#[derive(Default)]
pub(crate) struct Subscribers {
    /// subscriber가 하나라도 있는지다. subscriber가 없으면 publish는 이것만 읽는다.
    active: AtomicBool,
    list: RwLock<Arc<Vec<(u64, Subscriber)>>>,
    /// 다음 subscription의 id다.
    next_id: AtomicU64,
    /// 연결의 마지막 바깥 transaction 번호다.
    transactions: AtomicU64,
    /// 목록을 바꾸는 일을 차례로 한다.
    change: Mutex<()>,
}

/// A registered subscriber: `unsubscribe` removes it.
#[must_use = "dropping a Subscription keeps the subscriber registered; call unsubscribe to remove it"]
pub struct Subscription {
    db: Weak<DbInner>,
    id: u64,
}

impl Subscription {
    /// Removes the subscriber. It receives no event after this returns.
    pub fn unsubscribe(self) {
        if let Some(inner) = self.db.upgrade() {
            inner.subscribers.remove(self.id);
        }
    }
}

impl Subscribers {
    /// subscriber가 하나라도 있으면 true다.
    pub(crate) fn observed(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    fn add(&self, subscriber: Subscriber) -> u64 {
        let _change = self.change.lock().unwrap();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut list: Vec<(u64, Subscriber)> = self.list.read().unwrap().as_ref().clone();
        list.push((id, subscriber));
        *self.list.write().unwrap() = Arc::new(list);
        self.active.store(true, Ordering::Release);
        id
    }

    fn remove(&self, id: u64) {
        let _change = self.change.lock().unwrap();
        let list: Vec<(u64, Subscriber)> = self.list.read().unwrap().iter().filter(|(x, _)| *x != id).cloned().collect();
        self.active.store(!list.is_empty(), Ordering::Release);
        *self.list.write().unwrap() = Arc::new(list);
    }
}

impl Db {
    /// Registers `subscriber` for the statement events of the connection and
    /// of every clone of it. Subscribers run synchronously in registration
    /// order after each statement ends and before the operation continues. A
    /// subscriber must not fail: an error it returns stops the remaining
    /// subscribers and fails the operation with SUBSCRIBER, whose source is
    /// that error; the statement keeps its effect.
    pub fn subscribe<F: StatementSubscriber>(&self, subscriber: F) -> Subscription {
        let id = self.inner.subscribers.add(Arc::new(subscriber));
        Subscription { db: Arc::downgrade(&self.inner), id }
    }

    /// 새 바깥 transaction의 번호다.
    pub(crate) fn next_transaction(&self) -> u64 {
        self.inner.subscribers.transactions.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// 끝난 statement의 event를 publish하고 operation이 받을 결과를 돌려준다: subscriber가
    /// 실패하면 SUBSCRIBER, 아니면 statement의 결과다.
    pub(crate) fn statement_done<T>(&self, s: Sent<'_>, start: Instant, result: Result<T>) -> Result<T> {
        let subscribers = &self.inner.subscribers;
        if !subscribers.observed() {
            return result;
        }
        let list = subscribers.list.read().unwrap().clone();
        let event = StatementEvent {
            sql: s.sql,
            binds: s.binds,
            kind: s.kind,
            tables: s.tables,
            elapsed: start.elapsed(),
            transaction: s.transaction,
            error: result.as_ref().err(),
        };
        for (_, subscriber) in list.iter() {
            if let Err(source) = subscriber(&event) {
                return Err(Error::Subscriber { msg: format!("statement event subscriber failed: {source}"), source });
            }
        }
        result
    }
}

/// 보낸 statement 하나: 문장, bind, kind, table, transaction 번호다.
#[derive(Clone, Copy)]
pub(crate) struct Sent<'a> {
    pub(crate) sql: &'a str,
    pub(crate) binds: &'a [Param],
    pub(crate) kind: &'a str,
    pub(crate) tables: &'a [String],
    pub(crate) transaction: Option<u64>,
}

impl<'a> Sent<'a> {
    /// bind가 없는 statement다.
    pub(crate) fn bare(kind: &'a str, tables: &'a [String], transaction: Option<u64>, sql: &'a str) -> Sent<'a> {
        Sent { sql, binds: &[], kind, tables, transaction }
    }
}

/// planner가 쓴 statement의 kind다: SQL의 첫 단어다.
pub(crate) fn statement_kind(sql: &str) -> &'static str {
    let verb = sql.trim_start().split(|c: char| c.is_whitespace()).next().unwrap_or("");
    if verb.eq_ignore_ascii_case("INSERT") {
        KIND_INSERT
    } else if verb.eq_ignore_ascii_case("UPDATE") {
        KIND_UPDATE
    } else if verb.eq_ignore_ascii_case("DELETE") {
        KIND_DELETE
    } else {
        KIND_SELECT
    }
}

/// statement 하나를 `executor`에서 bind 없이 실행하고 그 event를 publish한다.
pub(crate) async fn raw<'c, E, DB>(db: &Db, executor: E, s: Sent<'_>) -> Result<()>
where
    E: sqlx::Executor<'c, Database = DB>,
    DB: sqlx::Database,
{
    let statement = sqlx::SqlSafeStr::into_sql_str(sqlx::AssertSqlSafe(s.sql.to_owned()));
    let start = Instant::now();
    let result = sqlx::raw_sql(statement).execute(executor).await.map(drop).map_err(Error::from);
    db.statement_done(s, start, result)
}
