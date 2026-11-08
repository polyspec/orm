//! The Rust ORM runtime. Generated models record requests; this crate plans
//! them into SQL for the connection's database (cached by request shape), runs
//! the statements with sqlx, and assembles models.

pub mod args;
mod array;
mod bind_check;
mod canonical;
mod cell;
pub mod codec;
pub mod codes;
pub mod collection;
pub mod core;
pub mod db;
pub mod dbspec;
pub mod decimal;
mod driver;
pub mod engine;
pub mod events;
pub mod ir;
pub mod listen;
pub mod markdown;
pub mod model;
pub mod plan;
mod request;
pub mod row;
pub mod schema;
mod sqlite_codes;
#[cfg(feature = "test-faults")]
pub mod testing;
pub mod tx;

#[cfg(test)]
#[path = "../tests/common/test_support.rs"]
mod test_support;
pub mod utils;
pub mod value;

pub use args::{
    date, day_of_week, days_ago, days_later, hours_ago, hours_later, minutes_ago, minutes_later, month, months_ago, months_later, now, seconds_ago,
    seconds_later, today, year, Func, GroupArg, IntoNullable, Null,
};
pub use array::ArrayValue;
pub use chrono;
pub use collection::{Collection, GroupLookaheadPage, GroupRow, GroupRows, Key, LookaheadPage, Page};
pub use core::Core;
pub use db::{AuditSource, Config, Db, DbStats, QueryPlanStep, RequestHook, RequestParams, Statement};
pub use engine::Dialect;
pub use events::{StatementEvent, StatementSubscriber, SubscriberError, Subscription};
pub use model::{AnyModel, Entity, Model};
pub use ordered_json;
pub use schema::{Manifest, Schema};
pub use serde;
pub use serde_json;
pub use tx::{transaction_conflict, Isolation, SendTransaction, Transaction, TransactionOnce, TransactionOnceError, TransactionOnceFuture, TxFrame};
pub use utils::{AesKeyring, AesRotationStatus, TablePrivileges, Utils};
pub use value::{Param, StyledValue, Val};

/// Every failure surfaces as one of these; engine codes pass through unchanged.
#[derive(Debug)]
pub enum Error {
    /// An error with a code from docs/spec/errors.yaml; `source` is the failure that caused it, such as the library
    /// failure under a codec stage text (COD-41), or None.
    Engine { code: String, msg: String, source: Option<Box<dyn std::error::Error + Send + Sync + 'static>> },
    /// A driver error: the code the error catalog names for it, or DRIVER,
    /// with the driver message and the driver error.
    Driver { code: String, msg: String, source: sqlx::Error },
    /// A strict one-row query matched no row.
    NoRows,
    /// Update with optimistic locking matched no row.
    OptimisticLock,
    /// Executor configuration problem (missing AES key, bad transform input, …).
    Config(String),
    /// A transaction or savepoint callback failed and its rollback failed too.
    Rollback { callback: Box<Error>, rollback: Box<Error> },
    /// A primary operation failed and one or more cleanup actions failed; the primary code remains observable.
    Cleanup { primary: Box<Error>, cleanup: Vec<Error> },
    /// A statement event subscriber failed (SUBSCRIBER); `source` is its error.
    Subscriber { msg: String, source: events::SubscriberError },
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Engine { code, msg, .. } => write!(f, "{code}: {msg}"),
            Error::Driver { code, msg, .. } => write!(f, "{code}: {msg}"),
            Error::NoRows => write!(f, "{}: query returned no rows", codes::NO_ROWS),
            Error::OptimisticLock => write!(f, "{}: row changed since it was read", codes::OPTIMISTIC_LOCK),
            Error::Config(m) => write!(f, "{}: {m}", codes::CONFIG),
            Error::Rollback { callback, rollback } => write!(f, "{}: {}", codes::ROLLBACK, rollback_message(callback, rollback)),
            Error::Cleanup { primary, cleanup } => {
                write!(f, "{} (cleanup failed: {})", primary, cleanup.iter().map(ToString::to_string).collect::<Vec<_>>().join("; "))
            }
            Error::Subscriber { msg, .. } => write!(f, "{}: {msg}", codes::SUBSCRIBER),
        }
    }
}

/// ROLLBACK error message: holds the failed callback's error and the failed rollback's error, in that order.
pub(crate) fn rollback_message(cause: &dyn std::fmt::Display, rollback: &dyn std::fmt::Display) -> String {
    format!("transaction failed ({cause}) and rollback failed ({rollback})")
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Driver { source, .. } => Some(source),
            Error::Engine { source: Some(source), .. } => Some(source.as_ref()),
            Error::Cleanup { primary, .. } => Some(primary),
            Error::Rollback { callback, .. } => Some(callback.as_ref()),
            Error::Subscriber { source, .. } => Some(source.as_ref()),
            _ => None,
        }
    }
}

/// The catalog code of a MySQL error number that the catalog names (docs/spec/errors.yaml), or None for any other number.
/// MySQL 1205 (a lock wait timeout) is the expiry of the write bound of CFG-6, so it is CANCELED like 1317 and 3024.
fn mysql_code(number: u16) -> Option<&'static str> {
    Some(match number {
        3572 => codes::LOCK_NOT_AVAILABLE,
        1213 => codes::DEADLOCK,
        1062 => codes::DUPLICATE_KEY,
        1451 | 1452 => codes::FOREIGN_KEY,
        1205 | 1317 | 3024 => codes::CANCELED,
        1290 | 1792 => codes::READ_ONLY,
        3819 | 4025 => codes::CONSTRAINT,
        // ER_CLIENT_INTERACTION_TIMEOUT: the server ended an idle connection.
        4031 => codes::CONNECTION_LOST,
        _ => return None,
    })
}

/// Driver errors: the codes the catalog names (docs/spec/errors.yaml, origin driver) map to a
/// shared code keeping the driver's message — MySQL 1213 / SQLSTATE 40001 → DEADLOCK, 1062 →
/// DUPLICATE_KEY; PostgreSQL 40P01 / 40001 → DEADLOCK, 23505 → DUPLICATE_KEY, 23503 → FOREIGN_KEY; SQLite LOCKED
/// (6, primary code of any extended form) → DEADLOCK, 2067 / 1555 (CONSTRAINT_UNIQUE / _PRIMARYKEY) →
/// DUPLICATE_KEY, 787 and the 1811 "FOREIGN KEY constraint failed" of a RESTRICT action → FOREIGN_KEY. A CHECK violation — MySQL 3819 / 4025, PostgreSQL 23514, SQLite 275 — maps
/// to CONSTRAINT. A statement stopped before it finished — MySQL 1317 / 3024,
/// PostgreSQL 57014, SQLite 9, and SQLite BUSY (5, any extended form: another connection held the lock
/// when busy_timeout ended) — maps to CANCELED. A write the read-only server or connection rejects —
/// MySQL 1290 / 1792, PostgreSQL 25006, SQLite READONLY (8, primary code of any extended form) — maps
/// to READ_ONLY. A connection the server ended or that broke — MySQL 4031, PostgreSQL SQLSTATE class 08 and
/// 57P01 / 57P02 / 57P05, and an I/O error of an open connection's socket (end of stream, reset, aborted,
/// broken pipe, not connected) — maps to CONNECTION_LOST. Every other driver error, such as a write that a trigger refuses, maps to DRIVER with the
/// driver message. Each keeps the driver error as its source.
impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        use sqlx::error::DatabaseError as _;
        if let Some(m) = e.as_database_error().and_then(|d| d.try_downcast_ref::<markdown::MarkdownServerError>()) {
            // A flowmark server answers the code of the error catalog with its message (docs/spec/protocol.md PRT-71).
            let (code, msg) = (m.code().to_owned(), sqlx::error::DatabaseError::message(m).to_owned());
            return Error::Driver { code, msg, source: e };
        }
        if let sqlx::Error::Database(d) = &e {
            // (shared code, the driver's message — with the SQLSTATE on PostgreSQL, whose
            // message text is localized, the way pgx renders it)
            let mapped = if let Some(m) = d.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>() {
                if m.number() == 1298 {
                    return Error::Config(format!("dsn timezone: {}; a named zone needs the MySQL time zone tables (mysql_tzinfo_to_sql)", m.message()));
                }
                // The sqlx code names the two errors that the number does not (ER_LOCK_NOWAIT, and SQLSTATE 40001 of a deadlock).
                let by_name = match m.code() {
                    Some("ER_LOCK_NOWAIT") => Some(codes::LOCK_NOT_AVAILABLE),
                    Some("40001") => Some(codes::DEADLOCK),
                    _ => None,
                };
                mysql_code(m.number()).or(by_name).map(|code| (code, m.message().to_owned()))
            } else if let Some(p) = d.try_downcast_ref::<sqlx::postgres::PgDatabaseError>() {
                let msg = || format!("{} (SQLSTATE {})", p.message(), p.code());
                match p.code() {
                    "55P03" => Some((codes::LOCK_NOT_AVAILABLE, msg())),
                    "40P01" | "40001" => Some((codes::DEADLOCK, msg())),
                    "23505" => Some((codes::DUPLICATE_KEY, msg())),
                    "23503" => Some((codes::FOREIGN_KEY, msg())),
                    "57014" => Some((codes::CANCELED, msg())),
                    "25006" => Some((codes::READ_ONLY, msg())),
                    "23514" => Some((codes::CONSTRAINT, msg())),
                    // Class 08 is connection exception. 57P01 (admin_shutdown), 57P02 (crash_shutdown),
                    // and 57P05 (idle_session_timeout) are sent when the server ends a session.
                    c if c.starts_with("08") || matches!(c, "57P01" | "57P02" | "57P05") => Some((codes::CONNECTION_LOST, msg())),
                    _ => Some((codes::DRIVER, msg())),
                }
            } else if let Some(s) = d.try_downcast_ref::<sqlx::sqlite::SqliteError>() {
                // sqlx reports the extended result code as text; a code that is missing or not a number is an explicit error with its text.
                let n: i64 = match s.code() {
                    Some(text) => match text.parse() {
                        Ok(n) => n,
                        Err(error) => {
                            return Error::Engine {
                                code: codes::DRIVER.into(),
                                msg: format!("sqlite reported extended result code {text:?}, which is not a number: {error}; {}", s.message()),
                                source: None,
                            };
                        }
                    },
                    None => {
                        return Error::Engine {
                            code: codes::DRIVER.into(),
                            msg: format!("sqlite reported no extended result code: {}", s.message()),
                            source: None,
                        }
                    }
                };
                // The message ends with the name of the extended result code (INT-154).
                Some((sqlite_extended_code(n, s.message()), format!("{}{}", s.message(), sqlite_codes::result_code_suffix(n))))
            } else {
                None
            };
            if let Some((code, msg)) = mapped {
                return Error::Driver { code: code.into(), msg, source: e };
            }
        }
        // The connection's socket was lost: the server ended the connection or the connection broke. An error that failed to open
        // the connection (such as ConnectionRefused) is not a lost-connection error.
        if let sqlx::Error::Io(io) = &e {
            // The handshake reports a refused certificate as an I/O error that holds the error of the TLS library (CFG-16).
            if io.get_ref().is_some_and(|inner| inner.downcast_ref::<rustls::Error>().is_some_and(|tls| matches!(tls, rustls::Error::InvalidCertificate(_)))) {
                return Error::Config(format!("TLS connection failed: {e}"));
            }
            use std::io::ErrorKind::*;
            if matches!(io.kind(), UnexpectedEof | ConnectionReset | ConnectionAborted | BrokenPipe | NotConnected) {
                return Error::Driver { code: codes::CONNECTION_LOST.into(), msg: e.to_string(), source: e };
            }
        }
        // A certificate that the CA or the host of the DSN refuses is CONFIG (CFG-16).
        if let sqlx::Error::Tls(_) = &e {
            return Error::Config(format!("TLS connection failed: {e}"));
        }
        Error::Driver { code: codes::DRIVER.into(), msg: e.to_string(), source: e }
    }
}

impl Error {
    pub fn code(&self) -> &str {
        match self {
            Error::Engine { code, .. } => code,
            Error::Driver { code, .. } => code,
            Error::NoRows => codes::NO_ROWS,
            Error::OptimisticLock => codes::OPTIMISTIC_LOCK,
            Error::Config(_) => codes::CONFIG,
            Error::Rollback { .. } => codes::ROLLBACK,
            Error::Cleanup { primary, .. } => primary.code(),
            Error::Subscriber { .. } => codes::SUBSCRIBER,
        }
    }

    /// The error of a callback that failed and whose rollback failed too.
    pub fn rollback(callback: Error, rollback: Error) -> Error {
        Error::Rollback { callback: Box::new(callback), rollback: Box::new(rollback) }
    }

    /// A DEADLOCK mapped at the driver boundary (`From<sqlx::Error>`): MySQL 1213 / 40001,
    /// PostgreSQL 40P01 / 40001, SQLite LOCKED.
    pub fn is_deadlock(&self) -> bool {
        self.code() == codes::DEADLOCK
    }

    pub(crate) fn internal(msg: impl Into<String>) -> Error {
        Error::Engine { code: codes::INTERNAL.into(), msg: msg.into(), source: None }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Reports SQLITE_BUSY or one of its extended codes.
/// The ORM code of a SQLite extended result code `n`, from the message of the driver error.
fn sqlite_extended_code(n: i64, message: &str) -> &'static str {
    match (n & 0xff, n) {
        (_, 2067) | (_, 1555) => codes::DUPLICATE_KEY,
        (_, 787) => codes::FOREIGN_KEY,
        // An FK violation from a RESTRICT action arrives as CONSTRAINT_TRIGGER (1811). The 1811 from a trigger RAISE is DRIVER.
        (_, 1811) if message.contains("FOREIGN KEY constraint failed") => codes::FOREIGN_KEY,
        (_, 275) => codes::CONSTRAINT,
        (5, _) | (9, _) => codes::CANCELED,
        (8, _) => codes::READ_ONLY,
        _ => codes::DRIVER,
    }
}

pub(crate) fn sqlite_busy(e: &sqlx::Error) -> Result<bool> {
    use sqlx::error::DatabaseError as _;
    // A flowmark server states SQLite's result code of a statement (docs/spec/protocol.md PRT-71).
    if let Some(m) = e.as_database_error().and_then(|d| d.try_downcast_ref::<markdown::MarkdownServerError>()) {
        return Ok(m.result_code().is_some_and(|n| n & 0xff == 5));
    }
    // An error that is not a SQLite database error has no code, so it is not busy.
    let Some(text) = e.as_database_error().and_then(|d| d.try_downcast_ref::<sqlx::sqlite::SqliteError>()).and_then(|s| s.code()) else {
        return Ok(false);
    };
    let n: i64 = text.parse().map_err(|error| Error::Engine {
        code: codes::DRIVER.into(),
        msg: format!("sqlite reported extended result code {text:?}, which is not a number: {error}"),
        source: None,
    })?;
    Ok(n & 0xff == 5)
}

/// Includes the models that `polyspec_orm_build` generated in the build script as the
/// module `model`.
#[macro_export]
macro_rules! models {
    () => {
        #[allow(
            dead_code,
            clippy::all,
            reason = "the generated models are included whole, a crate uses only some of them, and lints of hand-written code do not apply to generated code"
        )]
        pub mod model {
            include!(concat!(env!("OUT_DIR"), "/orm_model.rs"));
        }
    };
}

#[cfg(test)]
#[path = "../tests/common/or_panic.rs"]
mod or_panic;

#[cfg(test)]
mod sqlite_code_tests {
    use super::*;

    // Requirements: PLN-24.
    #[test]
    fn sqlite_locked_is_driver_not_deadlock() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        assert_eq!(sqlite_extended_code(6, "database table is locked"), codes::DRIVER);
        assert_eq!(sqlite_extended_code(262, "database table is locked"), codes::DRIVER);
    }

    // sqlite_codes.rs, which orm-gen sqlite-codes generates, names every code of the sqlite_result_codes table of
    // docs/spec/sqlite-result-codes.yaml and no other code: every other 16-bit code ends a message with its number. It
    // checks the generator against its table; the recipe case sqlite_extended_code_names tests the messages.
    #[test]
    fn result_code_names_match_the_table() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("cargo test sets CARGO_MANIFEST_DIR");
        let yaml = std::fs::read_to_string(format!("{manifest}/../../../docs/spec/sqlite-result-codes.yaml")).expect("docs/spec/sqlite-result-codes.yaml");
        let mut listed = std::collections::HashMap::new();
        let mut lines = yaml.lines().skip_while(|line| *line != "sqlite_result_codes:");
        while let Some(line) = lines.next() {
            if let Some(name) = line.strip_prefix("  - name: ") {
                let value = lines.next().and_then(|line| line.strip_prefix("    value: ")).expect("value line").parse::<i64>().expect("integer value");
                listed.insert(value, name.to_owned());
            }
        }
        assert!(!listed.is_empty(), "docs/spec/sqlite-result-codes.yaml lists no SQLite result codes");
        for code in 0..=0xffff_i64 {
            let want = match listed.get(&code) {
                Some(name) => format!(" ({name})"),
                None => format!(" (SQLite result code {code})"),
            };
            assert_eq!(super::sqlite_codes::result_code_suffix(code), want, "result code {code}");
        }
    }
}
