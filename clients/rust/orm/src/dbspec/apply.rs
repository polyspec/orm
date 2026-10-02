//! Applying plan chains (docs/plans.md, "Apply"): [`apply`] runs the plans of
//! a chain that the database has not applied under the dialect's lock, records
//! them in the history table `dbspec$plans` and verifies each by
//! introspection; [`recover`] finishes a MySQL plan that a stopped
//! connection left `running`, from the catalog effect of its statement.

use super::{chain, introspect, manifest, plan_statements, CatalogQuerier, CatalogValue, Dialect, Plan};
use chrono::{DateTime, Utc};
use regex::Regex;
use sqlx::{AssertSqlSafe, MySqlConnection, PgConnection, SqliteConnection};
use std::future::Future;
use std::sync::LazyLock;

/// The connection that [`apply`] and [`recover`] run on: it runs statements
/// and reads the catalog. The sqlx MySQL, PostgreSQL and SQLite connections
/// implement it; apply uses transactions and locks only on this connection.
pub trait ApplyConnection: CatalogQuerier {
    /// Runs one statement without bound values.
    fn execute(&mut self, statement: &str) -> impl Future<Output = Result<(), sqlx::Error>> + Send;
    /// Runs one statement with its bound values in placeholder order.
    fn execute_bound(&mut self, statement: &str, args: &[CatalogValue]) -> impl Future<Output = Result<(), sqlx::Error>> + Send;
    /// Runs one query with its bound values and returns its rows.
    fn query_bound(&mut self, query: &str, args: &[CatalogValue]) -> impl Future<Output = Result<Vec<Vec<CatalogValue>>, sqlx::Error>> + Send;
}

/// The kind of an [`ApplyEvent`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyEventKind {
    /// A plan starts; `steps` is its number of statements.
    Plan,
    /// Statement `step` is about to run.
    Statement,
    /// Statement `step` ran.
    Applied,
    /// The plan's schema is verified.
    Verified,
    /// The plan is recorded `done`.
    Done,
}

impl ApplyEventKind {
    /// The event name of docs/plans.md: plan, statement, applied, verified or done.
    pub fn as_str(self) -> &'static str {
        match self {
            ApplyEventKind::Plan => "plan",
            ApplyEventKind::Statement => "statement",
            ApplyEventKind::Applied => "applied",
            ApplyEventKind::Verified => "verified",
            ApplyEventKind::Done => "done",
        }
    }
}

/// One occurrence that apply reports (docs/plans.md, "Apply"). `step` and
/// `statement` belong to the statement events; the others carry 0 and an
/// empty statement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplyEvent {
    pub kind: ApplyEventKind,
    pub plan: String,
    pub step: usize,
    pub steps: usize,
    pub statement: String,
}

/// The error that an event handler returns to stop apply.
pub type ApplyEventError = Box<dyn std::error::Error + Send + Sync>;

/// The failure of [`apply`] and [`recover`]. The coded failures of
/// docs/plans.md carry their code through [`ApplyError::code`]: locked,
/// interrupted, drift, chain, failed and verify.
#[derive(Debug)]
pub enum ApplyError {
    /// Another session holds the lock; nothing changed.
    Locked { message: String, source: Option<sqlx::Error> },
    /// The history has a `running` row: plan `plan` stopped at `step`.
    Interrupted { plan: String, step: usize, message: String },
    /// The database is not at the state that its history records.
    Drift { message: String },
    /// The plans do not form a chain, or the history does not match it.
    Chain { plan: Option<String>, message: String },
    /// Statement `step` of plan `plan` failed.
    Failed { plan: String, step: usize, statement: String, source: sqlx::Error },
    /// The applied database is not the plan's target.
    Verify { plan: String, message: String },
    /// A history, lock or transaction statement failed.
    Database(sqlx::Error),
    /// An event handler stopped apply.
    Event(ApplyEventError),
    /// Releasing the PostgreSQL advisory lock released nothing: the session no
    /// longer held it.
    LockNotHeld { message: String },
    /// Ending the transaction, releasing the lock or restoring SQLite foreign
    /// keys failed with `cleanup` after `error`. A second cleanup failure
    /// wraps this one again, so the chain of `error` lists the failures in
    /// order.
    Cleanup { error: Box<ApplyError>, cleanup: Box<ApplyError> },
}

impl ApplyError {
    /// The code of docs/plans.md, or `None` for a database or event error.
    /// A cleanup failure has the code of the error it followed.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            ApplyError::Locked { .. } => Some("locked"),
            ApplyError::Interrupted { .. } => Some("interrupted"),
            ApplyError::Drift { .. } => Some("drift"),
            ApplyError::Chain { .. } => Some("chain"),
            ApplyError::Failed { .. } => Some("failed"),
            ApplyError::Verify { .. } => Some("verify"),
            ApplyError::Database(_) | ApplyError::Event(_) | ApplyError::LockNotHeld { .. } => None,
            ApplyError::Cleanup { error, .. } => error.code(),
        }
    }
}

impl std::fmt::Display for ApplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApplyError::Locked { message, source: None } => write!(f, "locked: {message}"),
            ApplyError::Locked { message, source: Some(e) } => write!(f, "locked: {message}: {e}"),
            ApplyError::Interrupted { plan, step, message } => write!(f, "interrupted {plan} at step {step}: {message}"),
            ApplyError::Drift { message } => write!(f, "drift: {message}"),
            ApplyError::Chain { plan: None, message } => write!(f, "chain: {message}"),
            ApplyError::Chain { plan: Some(plan), message } => write!(f, "chain {plan}: {message}"),
            ApplyError::Failed { plan, step, statement, source } => write!(f, "failed {plan} at step {step}: {statement}: {source}"),
            ApplyError::Verify { plan, message } => write!(f, "verify {plan}: {message}"),
            ApplyError::Database(e) => write!(f, "{e}"),
            ApplyError::Event(e) => write!(f, "{e}"),
            ApplyError::LockNotHeld { message } => write!(f, "{message}"),
            ApplyError::Cleanup { error, cleanup } => write!(f, "{error}; then {cleanup}"),
        }
    }
}

impl std::error::Error for ApplyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ApplyError::Locked { source: Some(e), .. } | ApplyError::Failed { source: e, .. } | ApplyError::Database(e) => Some(e),
            ApplyError::Event(e) => Some(e.as_ref()),
            ApplyError::Cleanup { error, .. } => Some(error.as_ref()),
            _ => None,
        }
    }
}

impl From<sqlx::Error> for ApplyError {
    fn from(e: sqlx::Error) -> Self {
        ApplyError::Database(e)
    }
}

/// 적용한 plan을 기록하는 table. dbspec 이름에는 `$`가 없으므로 사용자 table과
/// 겹치지 않고, introspection은 이 table을 빼고 읽는다.
const HISTORY_TABLE: &str = "dbspec$plans";

/// 현재 database 하나의 apply lock 이름. MySQL lock 이름은 64자까지이므로
/// database 이름 대신 그 SHA-256 hex 앞 51자를 붙여 64자로 만든다.
const MYSQL_LOCK: &str = "CONCAT('dbspec$plans$', LEFT(SHA2(DATABASE(), 256), 51))";

/// 현재 database의 현재 schema 하나의 advisory lock key.
const POSTGRES_LOCK: &str = "hashtext('dbspec$plans'), hashtext(current_schema())";

/// The handler of the apply events.
pub type ApplyEvents<'e> = dyn FnMut(&ApplyEvent) -> Result<(), ApplyEventError> + Send + 'e;

/// The clock of the `applied_at` column.
pub type ApplyClock<'c> = dyn Fn() -> DateTime<Utc> + Sync + 'c;

/// Applies the plans of the chain of `plans` that the database of
/// `connection` has not applied, one at a time; on a database that has
/// applied the whole chain it changes nothing. `dialect` must be the
/// database of the connection, `now` gives `applied_at` and `events` receives
/// every event; an error it returns stops apply at that point. When ending
/// the transaction, releasing the lock or restoring SQLite foreign keys fails
/// after a failure, the result is [`ApplyError::Cleanup`] with both.
pub async fn apply<C: ApplyConnection + ?Sized>(
    connection: &mut C,
    dialect: Dialect,
    plans: &[Plan],
    now: &ApplyClock<'_>,
    events: &mut ApplyEvents<'_>,
) -> Result<(), ApplyError> {
    let mut a = Applier::new(connection, dialect, plans, now, events)?;
    a.lock().await?;
    let result = a.apply_chain().await;
    a.unlock(result).await
}

/// Finishes the MySQL plan that apply left `running`, from the catalog effect
/// of its interrupted statement, then verifies it and records it `done`.
/// Without a `running` row it changes nothing. Failures are reported as for
/// [`apply`].
pub async fn recover<C: ApplyConnection + ?Sized>(
    connection: &mut C,
    dialect: Dialect,
    plans: &[Plan],
    now: &ApplyClock<'_>,
    events: &mut ApplyEvents<'_>,
) -> Result<(), ApplyError> {
    let mut a = Applier::new(connection, dialect, plans, now, events)?;
    a.lock().await?;
    let result = a.recover_chain().await;
    a.unlock(result).await
}

/// history table의 한 행.
struct HistoryRow {
    name: String,
    from: String,
    to: String,
    state: String,
    step: usize,
}

/// apply 한 번의 상태.
struct Applier<'a, C: ?Sized> {
    c: &'a mut C,
    d: Dialect,
    now: &'a ApplyClock<'a>,
    events: &'a mut ApplyEvents<'a>,
    chain: Vec<&'a Plan>,
}

/// dialect의 식별자 quote.
fn quote(d: Dialect, name: &str) -> String {
    match d {
        Dialect::MySql => format!("`{name}`"),
        _ => format!("\"{name}\""),
    }
}

fn hash_or_empty(hash: Option<&str>) -> &str {
    hash.unwrap_or("empty")
}

impl<'a, C: ApplyConnection + ?Sized> Applier<'a, C> {
    fn new(c: &'a mut C, d: Dialect, plans: &'a [Plan], now: &'a ApplyClock<'a>, events: &'a mut ApplyEvents<'a>) -> Result<Self, ApplyError> {
        let chain = chain(plans).map_err(|diagnostics| ApplyError::Chain { plan: None, message: diagnostics[0].message.clone() })?;
        Ok(Applier { c, d, now, events, chain })
    }

    fn placeholder(&self, n: usize) -> String {
        match self.d {
            Dialect::Postgres => format!("${n}"),
            _ => "?".to_owned(),
        }
    }

    /// 한 값만 돌려주는 query의 값.
    async fn value(&mut self, query: &str) -> Result<CatalogValue, ApplyError> {
        let rows = self.c.query_bound(query, &[]).await?;
        match <[Vec<CatalogValue>; 1]>::try_from(rows) {
            Ok([row]) => match <[CatalogValue; 1]>::try_from(row) {
                Ok([value]) => Ok(value),
                Err(row) => Err(ApplyError::Database(protocol(format!("{query} returned {} values; want one", row.len())))),
            },
            Err(rows) => Err(ApplyError::Database(protocol(format!("{query} returned {} rows; want one", rows.len())))),
        }
    }

    /// dialect의 lock을 잡는다. SQLite는 apply 전체를 한 transaction으로 실행하며
    /// 그 transaction이 lock이다.
    async fn lock(&mut self) -> Result<(), ApplyError> {
        match self.d {
            // GET_LOCK의 NULL은 lock을 기다리던 중의 error다.
            Dialect::MySql => match self.value(&format!("SELECT GET_LOCK({MYSQL_LOCK}, 0)")).await? {
                CatalogValue::Int(1) => Ok(()),
                CatalogValue::Int(0) => {
                    Err(ApplyError::Locked { message: format!("another session holds the {HISTORY_TABLE} lock of this database"), source: None })
                }
                other => Err(ApplyError::Database(protocol(format!("GET_LOCK returned {other:?}; want 1 or 0")))),
            },
            // current_schema()가 NULL이면 결과도 NULL이며 error다.
            Dialect::Postgres => match self.value(&format!("SELECT pg_try_advisory_lock({POSTGRES_LOCK})")).await? {
                CatalogValue::Bool(true) => Ok(()),
                CatalogValue::Bool(false) => {
                    Err(ApplyError::Locked { message: format!("another session holds the {HISTORY_TABLE} advisory lock of this schema"), source: None })
                }
                other => Err(ApplyError::Database(protocol(format!("pg_try_advisory_lock returned {other:?}")))),
            },
            Dialect::Sqlite => {
                self.c.execute("PRAGMA foreign_keys = OFF").await?;
                if let Err(e) = self.c.execute("BEGIN IMMEDIATE").await {
                    let locked = ApplyError::Locked { message: "another connection holds the SQLite write lock".to_owned(), source: Some(e) };
                    return match self.c.execute("PRAGMA foreign_keys = ON").await {
                        Ok(()) => Err(locked),
                        Err(cleanup) => Err(ApplyError::Cleanup { error: Box::new(locked), cleanup: Box::new(ApplyError::Database(cleanup)) }),
                    };
                }
                Ok(())
            }
        }
    }

    /// lock을 놓는다. SQLite는 `result`에 따라 commit하거나 rollback하고 foreign
    /// key를 다시 켠다. PostgreSQL에서 아무것도 풀지 않은 unlock은 error다. 정리의
    /// 실패는 앞선 error와 함께 알린다.
    async fn unlock(&mut self, result: Result<(), ApplyError>) -> Result<(), ApplyError> {
        match self.d {
            Dialect::MySql => {
                let released = self.c.execute(&format!("DO RELEASE_LOCK({MYSQL_LOCK})")).await.map_err(ApplyError::Database);
                settle(result, released)
            }
            Dialect::Postgres => {
                let released = match self.value(&format!("SELECT pg_advisory_unlock({POSTGRES_LOCK})")).await {
                    Ok(CatalogValue::Bool(true)) => Ok(()),
                    Ok(CatalogValue::Bool(false)) => {
                        Err(ApplyError::LockNotHeld { message: format!("the advisory lock of {HISTORY_TABLE} was not held at unlock") })
                    }
                    Ok(other) => Err(ApplyError::Database(protocol(format!("pg_advisory_unlock returned {other:?}")))),
                    Err(e) => Err(e),
                };
                settle(result, released)
            }
            Dialect::Sqlite => {
                let end = if result.is_ok() { "COMMIT" } else { "ROLLBACK" };
                let ended = self.c.execute(end).await.map_err(ApplyError::Database);
                let result = settle(result, ended);
                let restored = self.c.execute("PRAGMA foreign_keys = ON").await.map_err(ApplyError::Database);
                settle(result, restored)
            }
        }
    }

    async fn apply_chain(&mut self) -> Result<(), ApplyError> {
        let position = self.state().await?;
        for i in position..self.chain.len() {
            let p = self.chain[i];
            self.apply_plan(p, 0, false).await?;
        }
        Ok(())
    }

    async fn recover_chain(&mut self) -> Result<(), ApplyError> {
        let history = self.read_history().await?;
        for i in 0..self.chain.len() {
            let p = self.chain[i];
            let Some(row) = history.iter().find(|r| r.name == p.name() && r.state == "running") else {
                continue;
            };
            if self.d != Dialect::MySql {
                return Err(ApplyError::Interrupted {
                    plan: p.name().to_owned(),
                    step: row.step,
                    message: "only MySQL leaves a running plan; the row is not from apply".to_owned(),
                });
            }
            let statements = self.statements(p)?;
            let mut start = row.step;
            if start < statements.len() {
                let done = self.mysql_effect(&statements[start]).await.map_err(|source| ApplyError::Failed {
                    plan: p.name().to_owned(),
                    step: start,
                    statement: statements[start].clone(),
                    source,
                })?;
                if done {
                    start += 1;
                }
            }
            return self.apply_plan(p, start, true).await;
        }
        Ok(())
    }

    /// history table을 없을 때 만든다.
    async fn create_history(&mut self) -> Result<(), ApplyError> {
        let (integer, text, tail) = match self.d {
            Dialect::MySql => ("INT", "varchar(71) CHARACTER SET ascii COLLATE ascii_bin", " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin"),
            _ => ("integer", "varchar(71)", ""),
        };
        let d = self.d;
        let q = |n: &str| quote(d, n);
        let statement = format!(
            "CREATE TABLE IF NOT EXISTS {} ({} {text} NOT NULL, {} {text} NOT NULL, {} {text} NOT NULL, {} {text} NOT NULL, {} {integer} NOT NULL, {} {integer} NOT NULL, {} {text} NOT NULL, PRIMARY KEY ({})){tail}",
            q(HISTORY_TABLE),
            q("name"),
            q("from_hash"),
            q("to_hash"),
            q("state"),
            q("step"),
            q("steps"),
            q("applied_at"),
            q("name"),
        );
        Ok(self.c.execute(&statement).await?)
    }

    async fn read_history(&mut self) -> Result<Vec<HistoryRow>, ApplyError> {
        self.create_history().await?;
        let d = self.d;
        let q = |n: &str| quote(d, n);
        let query = format!("SELECT {}, {}, {}, {}, {} FROM {}", q("name"), q("from_hash"), q("to_hash"), q("state"), q("step"), q(HISTORY_TABLE));
        let rows = self.c.query_bound(&query, &[]).await?;
        rows.into_iter()
            .map(|row| match <[CatalogValue; 5]>::try_from(row) {
                Ok([CatalogValue::Text(name), CatalogValue::Text(from), CatalogValue::Text(to), CatalogValue::Text(state), CatalogValue::Int(step)]) => {
                    let step = usize::try_from(step).map_err(|_| ApplyError::Database(protocol(format!("{HISTORY_TABLE} row {name} has the step {step}"))))?;
                    Ok(HistoryRow { name, from, to, state, step })
                }
                Ok(other) => Err(ApplyError::Database(protocol(format!("{HISTORY_TABLE} has the row {other:?}")))),
                Err(other) => Err(ApplyError::Database(protocol(format!("{HISTORY_TABLE} has the row {other:?}")))),
            })
            .collect()
    }

    /// chain에서 다음에 적용할 plan의 위치. 기록이 chain과 맞지 않거나, 중단된
    /// plan이 있거나, catalog가 기록한 schema와 다르면 error다.
    async fn state(&mut self) -> Result<usize, ApplyError> {
        let history = self.read_history().await?;
        let mut position = 0;
        for (i, p) in self.chain.iter().enumerate() {
            let Some(row) = history.iter().find(|r| r.name == p.name()) else {
                continue;
            };
            if row.state == "running" {
                return Err(ApplyError::Interrupted { plan: p.name().to_owned(), step: row.step, message: "run recover".to_owned() });
            }
            if row.to != p.to() || row.from != hash_or_empty(p.from()) {
                return Err(ApplyError::Chain {
                    plan: Some(p.name().to_owned()),
                    message: "the recorded plan has other hashes than the chain's plan".to_owned(),
                });
            }
            if i != position {
                return Err(ApplyError::Chain { plan: Some(p.name().to_owned()), message: "a plan before it in the chain is not recorded".to_owned() });
            }
            position = i + 1;
        }
        if history.len() != position {
            return Err(ApplyError::Chain { plan: None, message: "the history records a plan that is not in the chain".to_owned() });
        }
        let want = if position > 0 { Some(self.chain[position - 1].to()) } else { None };
        self.verify(want).await.map_err(|message| ApplyError::Drift { message })?;
        Ok(position)
    }

    /// database의 introspection이 `want` schemaHash(None이면 빈 database)이고
    /// 미지원 객체가 없는지 확인한다. 다르면 그 차이를 돌려준다.
    async fn verify(&mut self, want: Option<&str>) -> Result<(), String> {
        let introspection = introspect(&mut *self.c, self.d, "schema").await.map_err(|e| e.to_string())?;
        if let Some(u) = introspection.unsupported.first() {
            return Err(format!(
                "the database has {} objects that dbspec cannot express, first {} {} {}: {}",
                introspection.unsupported.len(),
                u.kind,
                u.table,
                u.name,
                u.reason
            ));
        }
        let got = if introspection.document.tables.is_empty() {
            None
        } else {
            let m = manifest(&[&introspection.document]).map_err(|diagnostics| format!("the introspected schema is invalid: {diagnostics:?}"))?;
            Some(m.schema_hash)
        };
        if got.as_deref() != want {
            return Err(format!("the database is at {}, not {}", hash_or_empty(got.as_deref()), hash_or_empty(want)));
        }
        Ok(())
    }

    /// chain에서 plan의 앞 plan target을 source로 statement를 쓴다.
    fn statements(&self, p: &Plan) -> Result<Vec<String>, ApplyError> {
        let index = self.chain.iter().position(|c| std::ptr::eq(*c, p));
        let source = index.filter(|&i| i > 0).map(|i| self.chain[i - 1].schema());
        plan_statements(source, p, self.d).map_err(|diagnostics| ApplyError::Chain { plan: Some(p.name().to_owned()), message: diagnostics[0].message.clone() })
    }

    /// plan 하나를 `start` 번째 statement부터 적용하고 검증한다. `resume`이면
    /// 기록된 running row를 이어 쓴다.
    async fn apply_plan(&mut self, p: &Plan, start: usize, resume: bool) -> Result<(), ApplyError> {
        let statements = self.statements(p)?;
        self.emit(ApplyEventKind::Plan, p, 0, statements.len(), "")?;
        let postgres = self.d == Dialect::Postgres;
        if postgres {
            self.c.execute("BEGIN").await?;
        }
        let mut result = self.run_plan(p, &statements, start, resume).await;
        if postgres {
            let end = if result.is_ok() { "COMMIT" } else { "ROLLBACK" };
            result = settle(result, self.c.execute(end).await.map_err(ApplyError::Database));
        }
        result?;
        self.emit(ApplyEventKind::Done, p, 0, statements.len(), "")
    }

    async fn run_plan(&mut self, p: &Plan, statements: &[String], start: usize, resume: bool) -> Result<(), ApplyError> {
        let d = self.d;
        let q = |n: &str| quote(d, n);
        let steps = statements.len();
        let count = |n: usize| i64::try_from(n).map_err(|_| ApplyError::Database(protocol(format!("the step {n} does not fit a history row"))));
        if !resume {
            let placeholders: Vec<String> = (1..=7).map(|n| self.placeholder(n)).collect();
            let insert = format!(
                "INSERT INTO {} ({}, {}, {}, {}, {}, {}, {}) VALUES ({})",
                q(HISTORY_TABLE),
                q("name"),
                q("from_hash"),
                q("to_hash"),
                q("state"),
                q("step"),
                q("steps"),
                q("applied_at"),
                placeholders.join(", ")
            );
            // applied_at은 tool clock의 UTC 시각을 소수 여섯 자리로 버린 text다 (docs/plans.md "Apply").
            let applied_at = (self.now)().format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string();
            let args = [
                CatalogValue::Text(p.name().to_owned()),
                CatalogValue::Text(hash_or_empty(p.from()).to_owned()),
                CatalogValue::Text(p.to().to_owned()),
                CatalogValue::Text("running".to_owned()),
                CatalogValue::Int(0),
                CatalogValue::Int(count(steps)?),
                CatalogValue::Text(applied_at),
            ];
            self.c.execute_bound(&insert, &args).await?;
        }
        let update_step = format!("UPDATE {} SET {} = {} WHERE {} = {}", q(HISTORY_TABLE), q("step"), self.placeholder(1), q("name"), self.placeholder(2));
        if resume {
            self.c.execute_bound(&update_step, &[CatalogValue::Int(count(start)?), CatalogValue::Text(p.name().to_owned())]).await?;
        }
        for (i, statement) in statements.iter().enumerate().skip(start) {
            self.emit(ApplyEventKind::Statement, p, i, steps, statement)?;
            if let Err(source) = self.c.execute(statement).await {
                return Err(ApplyError::Failed { plan: p.name().to_owned(), step: i, statement: statement.clone(), source });
            }
            self.emit(ApplyEventKind::Applied, p, i, steps, statement)?;
            self.c.execute_bound(&update_step, &[CatalogValue::Int(count(i + 1)?), CatalogValue::Text(p.name().to_owned())]).await?;
        }
        if self.d == Dialect::Sqlite {
            match self.value("SELECT COUNT(*) FROM pragma_foreign_key_check").await? {
                CatalogValue::Int(0) => {}
                CatalogValue::Int(broken) => {
                    return Err(ApplyError::Verify { plan: p.name().to_owned(), message: format!("{broken} rows break a foreign key") })
                }
                other => return Err(ApplyError::Database(protocol(format!("pragma_foreign_key_check counted {other:?}")))),
            }
        }
        self.verify(Some(p.to())).await.map_err(|message| ApplyError::Verify { plan: p.name().to_owned(), message })?;
        self.emit(ApplyEventKind::Verified, p, 0, steps, "")?;
        let done = format!("UPDATE {} SET {} = 'done' WHERE {} = {}", q(HISTORY_TABLE), q("state"), q("name"), self.placeholder(1));
        Ok(self.c.execute_bound(&done, &[CatalogValue::Text(p.name().to_owned())]).await?)
    }

    fn emit(&mut self, kind: ApplyEventKind, p: &Plan, step: usize, steps: usize, statement: &str) -> Result<(), ApplyError> {
        (self.events)(&ApplyEvent { kind, plan: p.name().to_owned(), step, steps, statement: statement.to_owned() }).map_err(ApplyError::Event)
    }

    /// statement의 효과가 catalog에 있는지 알려 준다.
    async fn mysql_effect(&mut self, statement: &str) -> Result<bool, sqlx::Error> {
        for effect in MYSQL_EFFECTS.iter() {
            let Some(m) = effect.pattern.captures(statement) else {
                continue;
            };
            let group = |i: usize| CatalogValue::Text(m[i].to_owned());
            let (query, args) = match effect.kind {
                EffectKind::Repeat => return Ok(false),
                EffectKind::Trigger => {
                    ("SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?", vec![group(1)])
                }
                EffectKind::Table => ("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", vec![group(1)]),
                EffectKind::Column => (
                    "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
                    vec![group(1), group(2)],
                ),
                EffectKind::Constraint => (
                    "SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?",
                    vec![group(1), group(2)],
                ),
                EffectKind::Index => (
                    "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
                    vec![group(1), group(2)],
                ),
                EffectKind::IndexOn => (
                    "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
                    vec![group(2), group(1)],
                ),
            };
            let rows = self.c.query_bound(query, &args).await?;
            let n = match rows.as_slice() {
                [row] => match row.as_slice() {
                    [CatalogValue::Int(n)] => *n,
                    other => return Err(protocol(format!("{query} returned {other:?}"))),
                },
                _ => return Err(protocol(format!("{query} returned {} rows; want one", rows.len()))),
            };
            return Ok((n > 0) == effect.present);
        }
        Err(protocol(format!("statement {statement:?} has no known effect")))
    }
}

/// `result`에 정리 statement의 결과를 더한다. 앞선 error가 있으면 정리 실패를
/// 그 error와 함께 돌려준다.
fn settle(result: Result<(), ApplyError>, cleanup: Result<(), ApplyError>) -> Result<(), ApplyError> {
    match (result, cleanup) {
        (result, Ok(())) => result,
        (Ok(()), Err(e)) => Err(e),
        (Err(error), Err(cleanup)) => Err(ApplyError::Cleanup { error: Box::new(error), cleanup: Box::new(cleanup) }),
    }
}

/// 기대한 모양이 아닌 결과의 error.
fn protocol(message: String) -> sqlx::Error {
    sqlx::Error::Protocol(message)
}

/// MySQL statement가 catalog에 남기는 효과의 종류.
#[derive(Clone, Copy)]
enum EffectKind {
    /// 효과가 없는 MODIFY COLUMN은 다시 실행한다.
    Repeat,
    Trigger,
    Table,
    Column,
    Constraint,
    /// 첫 group이 table, 둘째가 index다.
    Index,
    /// 첫 group이 index, 둘째가 table이다.
    IndexOn,
}

struct MySqlEffect {
    pattern: Regex,
    kind: EffectKind,
    present: bool,
}

/// plan writer가 쓰는 MySQL statement 형식과 그 효과(docs/plans.md "Apply", recovery).
static MYSQL_EFFECTS: LazyLock<Vec<MySqlEffect>> = LazyLock::new(|| {
    let effect = |pattern: &str, kind, present| MySqlEffect { pattern: Regex::new(pattern).expect("constant MySQL effect pattern"), kind, present };
    vec![
        effect("^DROP TRIGGER `([^`]+)`$", EffectKind::Trigger, false),
        effect("^ALTER TABLE `([^`]+)` DROP FOREIGN KEY `([^`]+)`$", EffectKind::Constraint, false),
        effect("^ALTER TABLE `([^`]+)` DROP CHECK `([^`]+)`$", EffectKind::Constraint, false),
        effect("^ALTER TABLE `([^`]+)` DROP INDEX `([^`]+)`$", EffectKind::Index, false),
        effect("^DROP INDEX `([^`]+)` ON `([^`]+)`$", EffectKind::IndexOn, false),
        effect("^ALTER TABLE `[^`]+` RENAME TO `([^`]+)`$", EffectKind::Table, true),
        effect("^ALTER TABLE `([^`]+)` RENAME COLUMN `[^`]+` TO `([^`]+)`$", EffectKind::Column, true),
        effect("^ALTER TABLE `([^`]+)` DROP COLUMN `([^`]+)`$", EffectKind::Column, false),
        effect("^DROP TABLE `([^`]+)`$", EffectKind::Table, false),
        effect("^CREATE TABLE `([^`]+)` ", EffectKind::Table, true),
        effect("^CREATE INDEX `([^`]+)` ON `([^`]+)` ", EffectKind::IndexOn, true),
        effect("^ALTER TABLE `([^`]+)` ADD COLUMN `([^`]+)` ", EffectKind::Column, true),
        effect("^ALTER TABLE `[^`]+` MODIFY COLUMN ", EffectKind::Repeat, false),
        effect("^ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)` UNIQUE ", EffectKind::Index, true),
        effect("^ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)` (CHECK|FOREIGN KEY) ", EffectKind::Constraint, true),
        effect("^CREATE TRIGGER `([^`]+)` ", EffectKind::Trigger, true),
    ]
});

/// 값을 placeholder 순서로 bind한다.
fn bound<'q, DB: sqlx::Database>(query: &str, args: &[CatalogValue]) -> sqlx::query::Query<'q, DB, DB::Arguments>
where
    for<'t> i64: sqlx::Encode<'t, DB> + sqlx::Type<DB>,
    for<'t> String: sqlx::Encode<'t, DB> + sqlx::Type<DB>,
    for<'t> bool: sqlx::Encode<'t, DB> + sqlx::Type<DB>,
    for<'t> Option<String>: sqlx::Encode<'t, DB> + sqlx::Type<DB>,
{
    let mut q = sqlx::query::<DB>(AssertSqlSafe(query.to_owned()));
    for arg in args {
        q = match arg {
            CatalogValue::Null => q.bind(None::<String>),
            CatalogValue::Text(s) => q.bind(s.clone()),
            CatalogValue::Int(n) => q.bind(*n),
            CatalogValue::Bool(b) => q.bind(*b),
        };
    }
    q
}

impl ApplyConnection for MySqlConnection {
    async fn execute(&mut self, statement: &str) -> Result<(), sqlx::Error> {
        sqlx::raw_sql(AssertSqlSafe(statement.to_owned())).execute(self).await.map(drop)
    }

    async fn execute_bound(&mut self, statement: &str, args: &[CatalogValue]) -> Result<(), sqlx::Error> {
        bound::<sqlx::MySql>(statement, args).execute(self).await.map(drop)
    }

    async fn query_bound(&mut self, query: &str, args: &[CatalogValue]) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        let rows = bound::<sqlx::MySql>(query, args).fetch_all(self).await?;
        rows.iter().map(|row| (0..sqlx::Row::len(row)).map(|i| super::mysql_value(row, i)).collect()).collect()
    }
}

impl ApplyConnection for PgConnection {
    async fn execute(&mut self, statement: &str) -> Result<(), sqlx::Error> {
        sqlx::raw_sql(AssertSqlSafe(statement.to_owned())).execute(self).await.map(drop)
    }

    async fn execute_bound(&mut self, statement: &str, args: &[CatalogValue]) -> Result<(), sqlx::Error> {
        bound::<sqlx::Postgres>(statement, args).execute(self).await.map(drop)
    }

    async fn query_bound(&mut self, query: &str, args: &[CatalogValue]) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        let rows = bound::<sqlx::Postgres>(query, args).fetch_all(self).await?;
        rows.iter().map(|row| (0..sqlx::Row::len(row)).map(|i| super::postgres_value(row, i)).collect()).collect()
    }
}

impl ApplyConnection for SqliteConnection {
    async fn execute(&mut self, statement: &str) -> Result<(), sqlx::Error> {
        sqlx::raw_sql(AssertSqlSafe(statement.to_owned())).execute(self).await.map(drop)
    }

    async fn execute_bound(&mut self, statement: &str, args: &[CatalogValue]) -> Result<(), sqlx::Error> {
        bound::<sqlx::Sqlite>(statement, args).execute(self).await.map(drop)
    }

    async fn query_bound(&mut self, query: &str, args: &[CatalogValue]) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        let rows = bound::<sqlx::Sqlite>(query, args).fetch_all(self).await?;
        rows.iter().map(|row| (0..sqlx::Row::len(row)).map(|i| super::sqlite_value(row, i)).collect()).collect()
    }
}
