//! The Rust ORM runtime. Generated models record requests; this crate plans
//! them into SQL for the connection's database (cached by request shape), runs
//! the statements with sqlx, and assembles models.

mod aggregate;
pub mod args;
mod array;
mod bind_check;
mod canonical;
mod cell;
pub mod codec;
pub mod collection;
pub mod core;
pub mod db;
pub mod dbspec;
pub mod decimal;
mod driver;
pub mod engine;
mod error;
pub mod events;
pub mod ir;
mod kind;
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
pub use db::{AuditSource, Config, Db, DbStats, QueryPlanStep, RequestHook, RequestParams, Statement, DEFAULT_POOL_ACQUIRE_TIMEOUT_MS};
pub use engine::Dialect;
pub use error::{CallbackFailure, Error};
pub use events::{StatementEvent, StatementSubscriber, SubscriberError, Subscription};
pub use kind::Kind;
pub use model::{AnyModel, Entity, Model};
pub use ordered_json;
pub use schema::{Manifest, Schema};
pub use serde;
pub use serde_json;
pub use tx::{transaction_conflict, Connection, Isolation, TransactionOptions, Tx, DEFAULT_RETRY};
pub use utils::{AesKeyring, AesRotationStatus, TablePrivileges, Utils};
pub use value::{Param, StyledValue, Val};

/// The catalog code of a MySQL error number that the catalog names (docs/spec/errors.yaml), or None for any other number.
/// MySQL 1205 (a lock wait timeout) is the expiry of the write bound of CFG-6, so it is CANCELED like 1317 and 3024.
fn mysql_code(number: u16) -> Option<Kind> {
    Some(match number {
        3572 => Kind::LockNotAvailable,
        1213 => Kind::Deadlock,
        1062 => Kind::DuplicateKey,
        1451 | 1452 => Kind::ForeignKey,
        1205 | 1317 | 3024 => Kind::Canceled,
        1290 | 1792 => Kind::ReadOnly,
        // MySQL's 4025 is ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE, which is DRIVER (DIA-201).
        3819 => Kind::Constraint,
        // ER_CLIENT_INTERACTION_TIMEOUT: the server ended an idle connection.
        4031 => Kind::ConnectionLost,
        _ => return None,
    })
}

/// The catalog code of a MariaDB error number (DIA-201), which MariaDB numbers otherwise than MySQL above 1999: it has no
/// 3572, 3819, 3024 or 4031 of MySQL; its 4025 is ER_CONSTRAINT_FAILED and its 1969 ER_STATEMENT_TIMEOUT.
fn mariadb_code(number: u16) -> Option<Kind> {
    Some(match number {
        1213 => Kind::Deadlock,
        1062 => Kind::DuplicateKey,
        1451 | 1452 => Kind::ForeignKey,
        1205 | 1317 | 1969 => Kind::Canceled,
        1290 | 1792 => Kind::ReadOnly,
        4025 => Kind::Constraint,
        _ => return None,
    })
}

/// The catalog code of a MariaDB error `number` with SQLSTATE `state` of a statement that took the row lock `lock`, empty for
/// none (DIA-201, DIA-209): 1205 of a `*_nowait` lock is LOCK_NOT_AVAILABLE, and every other error is read by MariaDB's
/// table, SQLSTATE 40001 is DEADLOCK, and any other is DRIVER.
fn mariadb_statement_code(number: u16, state: Option<&str>, lock: &str) -> Kind {
    if number == 1205 && matches!(lock, "update_nowait" | "share_nowait") {
        return Kind::LockNotAvailable;
    }
    mariadb_code(number).or((state == Some("40001")).then_some(Kind::Deadlock)).unwrap_or(Kind::Driver)
}

/// The server of a mysql connection, which the connection reads once by `VERSION()` (DIA-201).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MySqlServer {
    MySql,
    MariaDb,
}

impl MySqlServer {
    /// The server that a `VERSION()` names: one that contains `-MariaDB` is MariaDB, and any other is MySQL (DIA-201).
    pub(crate) fn of_version(version: &str) -> MySqlServer {
        if version.contains("-MariaDB") {
            MySqlServer::MariaDb
        } else {
            MySqlServer::MySql
        }
    }

    /// The statement that sets the statement timeout of `ms` milliseconds on a connection of the server (DIA-208): MySQL
    /// bounds a SELECT by `max_execution_time` in milliseconds, and MariaDB every statement by `max_statement_time` in
    /// seconds, written with three fraction digits.
    pub(crate) fn statement_timeout(self, ms: u32) -> String {
        match self {
            MySqlServer::MySql => format!("SET SESSION max_execution_time = {ms}"),
            MySqlServer::MariaDb => format!("SET SESSION max_statement_time = {}.{:03}", ms / 1000, ms % 1000),
        }
    }
}

impl Error {
    /// The error with the code that the table of its server gives a MySQL error number (DIA-201): `From<sqlx::Error>` reads
    /// a number by MySQL's table, so on MariaDB a database error of a mysql connection is read again by MariaDB's. `lock` is
    /// the row lock that the failing statement took, empty for a statement with none: MariaDB fails a NOWAIT lock that it
    /// cannot take at once with 1205, its lock wait timeout, so 1205 of a statement of a `*_nowait` lock is
    /// LOCK_NOT_AVAILABLE, as MySQL's 3572 is, and 1205 of any other statement stays CANCELED (DIA-209).
    pub(crate) fn for_server(self, server: MySqlServer, lock: &str) -> Error {
        if server != MySqlServer::MariaDb {
            return self;
        }
        let kind = match self.driver_error() {
            Some(sqlx::Error::Database(d)) => match d.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>() {
                Some(m) => mariadb_statement_code(m.number(), m.code(), lock),
                None => return self,
            },
            Some(_) | None => return self,
        };
        self.rekind(kind)
    }
}

/// Driver errors: the codes the catalog names (docs/spec/errors.yaml, origin driver) map to a
/// shared code keeping the driver's message — MySQL 1213 / SQLSTATE 40001 → DEADLOCK, 1062 →
/// DUPLICATE_KEY; PostgreSQL 40P01 / 40001 → DEADLOCK, 23505 → DUPLICATE_KEY, 23503 → FOREIGN_KEY; SQLite LOCKED
/// (6, primary code of any extended form) → DEADLOCK, 2067 / 1555 (CONSTRAINT_UNIQUE / _PRIMARYKEY) →
/// DUPLICATE_KEY, 787 and the 1811 "FOREIGN KEY constraint failed" of a RESTRICT action → FOREIGN_KEY. A CHECK violation — MySQL 3819 (MariaDB 4025, read by `Error::for_server`), PostgreSQL 23514, SQLite 275 — maps
/// to CONSTRAINT. A statement stopped before it finished — MySQL 1317 / 3024,
/// PostgreSQL 57014, SQLite 9, and SQLite BUSY (5, any extended form: another connection held the lock
/// when busy_timeout ended) — maps to CANCELED. A write the read-only server or connection rejects —
/// MySQL 1290 / 1792, PostgreSQL 25006, SQLite READONLY (8, primary code of any extended form) — maps
/// to READ_ONLY. A connection the server ended or that broke — MySQL 4031, PostgreSQL SQLSTATE class 08 and
/// 25P03 / 57P01 / 57P02 / 57P05, and an I/O error of an open connection's socket (end of stream, reset, aborted,
/// broken pipe, not connected) — maps to CONNECTION_LOST. Every other driver error, such as a write that a trigger refuses, maps to DRIVER with the
/// driver message. Each keeps the driver error as its source.
impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        use sqlx::error::DatabaseError as _;
        if let Some(m) = e.as_database_error().and_then(|d| d.try_downcast_ref::<markdown::MarkdownServerError>()) {
            // A flowmark server answers the code of the error catalog with its message (docs/spec/protocol.md PRT-71).
            let code = m.code().to_owned();
            let msg = sqlx::error::DatabaseError::message(m).to_owned();
            return match Kind::ALL.into_iter().find(|kind| kind.as_str().to_ascii_uppercase() == code) {
                Some(kind) => Error::driver(kind, msg, e),
                None => Error::driver(
                    Kind::Driver,
                    format!("the markdown server answered the code {} that is no kind of the core: {msg}", polyspec_orm_schema::message::Quoted(&code)),
                    e,
                ),
            };
        }
        if let sqlx::Error::Database(d) = &e {
            // (shared code, the driver's message — with the SQLSTATE on PostgreSQL, whose
            // message text is localized, the way pgx renders it)
            let mapped = if let Some(m) = d.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>() {
                if m.number() == 1298 {
                    return Error::config(format!("dsn timezone: {}; a named zone needs the MySQL time zone tables (mysql_tzinfo_to_sql)", m.message()));
                }
                // The sqlx code names the two errors that the number does not (ER_LOCK_NOWAIT, and SQLSTATE 40001 of a deadlock).
                let by_name = match m.code() {
                    Some("ER_LOCK_NOWAIT") => Some(Kind::LockNotAvailable),
                    Some("40001") => Some(Kind::Deadlock),
                    _ => None,
                };
                mysql_code(m.number()).or(by_name).map(|code| (code, m.message().to_owned()))
            } else if let Some(p) = d.try_downcast_ref::<sqlx::postgres::PgDatabaseError>() {
                let msg = || format!("{} (SQLSTATE {})", p.message(), p.code());
                match p.code() {
                    "55P03" => Some((Kind::LockNotAvailable, msg())),
                    "40P01" | "40001" => Some((Kind::Deadlock, msg())),
                    "23505" => Some((Kind::DuplicateKey, msg())),
                    "23503" => Some((Kind::ForeignKey, msg())),
                    "57014" => Some((Kind::Canceled, msg())),
                    "25006" => Some((Kind::ReadOnly, msg())),
                    "23514" => Some((Kind::Constraint, msg())),
                    // Class 08 is connection exception. 57P01 (admin_shutdown), 57P02 (crash_shutdown),
                    // 57P05 (idle_session_timeout) and 25P03 (idle_in_transaction_session_timeout) are sent when the server ends a session.
                    c if c.starts_with("08") || matches!(c, "25P03" | "57P01" | "57P02" | "57P05") => Some((Kind::ConnectionLost, msg())),
                    _ => Some((Kind::Driver, msg())),
                }
            } else if let Some(s) = d.try_downcast_ref::<sqlx::sqlite::SqliteError>() {
                // sqlx reports the extended result code as text; a code that is missing or not a number is an explicit error with its text.
                let n: i64 = match s.code() {
                    Some(text) => match text.parse() {
                        Ok(n) => n,
                        Err(error) => {
                            return Error::new(
                                Kind::Driver,
                                format!(
                                    "sqlite reported extended result code {text}, which is not a number: {error}; {}",
                                    s.message(),
                                    text = polyspec_orm_schema::message::Quoted(&text)
                                ),
                            );
                        }
                    },
                    None => return Error::new(Kind::Driver, format!("sqlite reported no extended result code: {}", s.message())),
                };
                // The message ends with the name of the extended result code (INT-154).
                Some((sqlite_extended_code(n, s.message()), format!("{}{}", s.message(), sqlite_codes::result_code_suffix(n))))
            } else {
                None
            };
            if let Some((kind, msg)) = mapped {
                return Error::driver(kind, msg, e);
            }
        }
        // The connection's socket was lost: the server ended the connection or the connection broke. An error that failed to open
        // the connection (such as ConnectionRefused) is not a lost-connection error.
        if let sqlx::Error::Io(io) = &e {
            // The handshake reports a refused certificate as an I/O error that holds the error of the TLS library (CFG-16).
            if io.get_ref().is_some_and(|inner| inner.downcast_ref::<rustls::Error>().is_some_and(|tls| matches!(tls, rustls::Error::InvalidCertificate(_)))) {
                return Error::config(format!("TLS connection failed: {e}"));
            }
            use std::io::ErrorKind::*;
            if matches!(io.kind(), UnexpectedEof | ConnectionReset | ConnectionAborted | BrokenPipe | NotConnected) {
                return Error::driver(Kind::ConnectionLost, e.to_string(), e);
            }
        }
        // A wait for a connection of the pool beyond its bound (CORE-30), and a pool that was closed while a call waited for
        // one (CORE-31).
        if let sqlx::Error::PoolTimedOut = &e {
            return Error::driver(Kind::PoolTimeout, "no connection of the pool became free within pool_acquire_timeout_ms", e);
        }
        if let sqlx::Error::PoolClosed = &e {
            return Error::driver(Kind::Closed, "database is closed", e);
        }
        // A certificate that the CA or the host of the DSN refuses is CONFIG (CFG-16).
        if let sqlx::Error::Tls(_) = &e {
            return Error::config(format!("TLS connection failed: {e}"));
        }
        Error::driver(Kind::Driver, e.to_string(), e)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Reports SQLITE_BUSY or one of its extended codes.
/// The ORM code of a SQLite extended result code `n`, from the message of the driver error.
fn sqlite_extended_code(n: i64, message: &str) -> Kind {
    match (n & 0xff, n) {
        (_, 2067) | (_, 1555) => Kind::DuplicateKey,
        (_, 787) => Kind::ForeignKey,
        // An FK violation from a RESTRICT action arrives as CONSTRAINT_TRIGGER (1811). The 1811 from a trigger RAISE is DRIVER.
        (_, 1811) if message.contains("FOREIGN KEY constraint failed") => Kind::ForeignKey,
        (_, 275) => Kind::Constraint,
        (5, _) | (9, _) => Kind::Canceled,
        (8, _) => Kind::ReadOnly,
        _ => Kind::Driver,
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
    let n: i64 = text.parse().map_err(|error| {
        Error::new(
            Kind::Driver,
            format!("sqlite reported extended result code {text}, which is not a number: {error}", text = polyspec_orm_schema::message::Quoted(&text)),
        )
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
        assert_eq!(sqlite_extended_code(6, "database table is locked"), Kind::Driver);
        assert_eq!(sqlite_extended_code(262, "database table is locked"), Kind::Driver);
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
