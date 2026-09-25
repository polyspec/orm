//! The Rust ORM runtime. Generated models record requests; this crate plans
//! them into SQL for the connection's database (cached by request shape), runs
//! the statements with sqlx, and assembles models.

pub mod args;
pub mod codec;
pub mod codes;
pub mod collection;
pub mod core;
pub mod db;
mod driver;
pub mod engine;
pub mod ir;
pub mod model;
pub mod plan;
mod request;
pub mod row;
pub mod schema;
pub mod tx;
pub mod utils;
pub mod value;

pub use args::{
    date, day_of_week, days_ago, days_later, distance, hours_ago, hours_later, minutes_ago, minutes_later, month, months_ago, months_later, now, point_x,
    point_y, seconds_ago, seconds_later, today, year, Binds, Func, GroupArg, IntoNullable, Null,
};
pub use chrono;
pub use collection::{Collection, Key, Page};
pub use core::Core;
pub use db::{Config, Db, DbStats, OnQuery, Statement};
pub use engine::Dialect;
pub use model::{AnyModel, Entity, Model};
pub use ordered_json;
pub use schema::{Manifest, Schema};
pub use serde;
pub use serde_json;
pub use tx::{transaction_conflict, Isolation, Transaction};
pub use utils::{AesKeyring, AesRotationStatus, TablePrivileges, Utils};
pub use value::{parse_point, point_text, Param, Point, Val};

/// Every failure surfaces as one of these; engine codes pass through unchanged.
#[derive(Debug)]
pub enum Error {
    /// An error with a code from docs/errors.yaml.
    Engine { code: String, msg: String },
    /// Driver error.
    Sqlx(sqlx::Error),
    /// A strict one-row query matched no row.
    NoRows,
    /// Update with optimistic locking matched no row.
    OptimisticLock,
    /// Executor configuration problem (missing AES key, bad transform input, …).
    Config(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Engine { code, msg } => write!(f, "{code}: {msg}"),
            Error::Sqlx(e) => write!(f, "sqlx: {e}"),
            Error::NoRows => write!(f, "{}: query returned no rows", codes::NO_ROWS),
            Error::OptimisticLock => write!(f, "{}: row changed since it was read", codes::OPTIMISTIC_LOCK),
            Error::Config(m) => write!(f, "{}: {m}", codes::CONFIG),
        }
    }
}

impl std::error::Error for Error {}

/// Driver errors: the codes the catalog names (docs/errors.yaml, origin driver) map to a
/// shared code keeping the driver's message — MySQL 1213 / SQLSTATE 40001 → DEADLOCK, 1062 →
/// DUPLICATE_KEY; PostgreSQL 40P01 / 40001 → DEADLOCK, 23505 → DUPLICATE_KEY, 23503 → FOREIGN_KEY; SQLite LOCKED
/// (6, primary code of any extended form) → DEADLOCK, 2067 / 1555 (CONSTRAINT_UNIQUE / _PRIMARYKEY) →
/// DUPLICATE_KEY, 787 / 1811 → FOREIGN_KEY. A statement stopped before it finished — MySQL 1317 / 3024,
/// PostgreSQL 57014, SQLite 9, and SQLite BUSY (5, any extended form: another connection held the lock
/// when busy_timeout ended) — maps to CANCELED. A write the read-only server or connection rejects —
/// MySQL 1290 / 1792, PostgreSQL 25006, SQLite READONLY (8, primary code of any extended form) — maps
/// to READ_ONLY. Everything else stays `Error::Sqlx`.
impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        use sqlx::error::DatabaseError as _;
        if let sqlx::Error::Database(d) = &e {
            // (shared code, the driver's message — with the SQLSTATE on PostgreSQL, whose
            // message text is localized, the way pgx renders it)
            let mapped = if let Some(m) = d.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>() {
                match (m.number(), m.code()) {
                    (3572, _) | (_, Some("ER_LOCK_NOWAIT")) => Some((codes::LOCK_NOT_AVAILABLE, m.message().to_owned())),
                    (1213, _) | (_, Some("40001")) => Some((codes::DEADLOCK, m.message().to_owned())),
                    (1062, _) => Some((codes::DUPLICATE_KEY, m.message().to_owned())),
                    (1317, _) | (3024, _) => Some((codes::CANCELED, m.message().to_owned())),
                    (1451, _) | (1452, _) => Some((codes::FOREIGN_KEY, m.message().to_owned())),
                    (1290, _) | (1792, _) => Some((codes::READ_ONLY, m.message().to_owned())),
                    (1298, _) => {
                        return Error::Config(format!("dsn timezone: {}; a named zone needs the MySQL time zone tables (mysql_tzinfo_to_sql)", m.message()))
                    }
                    _ => None,
                }
            } else if let Some(p) = d.try_downcast_ref::<sqlx::postgres::PgDatabaseError>() {
                let msg = || format!("{} (SQLSTATE {})", p.message(), p.code());
                match p.code() {
                    "55P03" => Some((codes::LOCK_NOT_AVAILABLE, msg())),
                    "40P01" | "40001" => Some((codes::DEADLOCK, msg())),
                    "23505" => Some((codes::DUPLICATE_KEY, msg())),
                    "23503" => Some((codes::FOREIGN_KEY, msg())),
                    "57014" => Some((codes::CANCELED, msg())),
                    "25006" => Some((codes::READ_ONLY, msg())),
                    _ => None,
                }
            } else if let Some(s) = d.try_downcast_ref::<sqlx::sqlite::SqliteError>() {
                // sqlx reports the extended result code as text
                let n: i64 = s.code().and_then(|c| c.parse().ok()).unwrap_or(0);
                match (n & 0xff, n) {
                    (6, _) => Some((codes::DEADLOCK, s.message().to_owned())),
                    (_, 2067) | (_, 1555) => Some((codes::DUPLICATE_KEY, s.message().to_owned())),
                    (_, 787) | (_, 1811) => Some((codes::FOREIGN_KEY, s.message().to_owned())),
                    (5, _) | (9, _) => Some((codes::CANCELED, s.message().to_owned())),
                    (8, _) => Some((codes::READ_ONLY, s.message().to_owned())),
                    _ => None,
                }
            } else {
                None
            };
            if let Some((code, msg)) = mapped {
                return Error::Engine { code: code.into(), msg };
            }
        }
        Error::Sqlx(e)
    }
}

impl Error {
    pub fn code(&self) -> &str {
        match self {
            Error::Engine { code, .. } => code,
            Error::Sqlx(_) => "SQLX",
            Error::NoRows => codes::NO_ROWS,
            Error::OptimisticLock => codes::OPTIMISTIC_LOCK,
            Error::Config(_) => codes::CONFIG,
        }
    }

    /// A DEADLOCK mapped at the driver boundary (`From<sqlx::Error>`): MySQL 1213 / 40001,
    /// PostgreSQL 40P01 / 40001, SQLite LOCKED.
    pub fn is_deadlock(&self) -> bool {
        self.code() == codes::DEADLOCK
    }

    pub(crate) fn internal(msg: impl Into<String>) -> Error {
        Error::Engine { code: codes::INTERNAL.into(), msg: msg.into() }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Reports SQLITE_BUSY or one of its extended codes.
pub(crate) fn sqlite_busy(e: &sqlx::Error) -> bool {
    use sqlx::error::DatabaseError as _;
    let code = e.as_database_error().and_then(|d| d.try_downcast_ref::<sqlx::sqlite::SqliteError>()).and_then(|s| s.code()).and_then(|c| c.parse::<i64>().ok());
    code.is_some_and(|n| n & 0xff == 5)
}

/// Includes the models that `orm_build` generated in the build script as the
/// module `model`.
#[macro_export]
macro_rules! models {
    () => {
        #[allow(dead_code, clippy::all)]
        pub mod model {
            include!(concat!(env!("OUT_DIR"), "/orm_model.rs"));
        }
    };
}
