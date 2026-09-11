//! Rust executor for the orm engine. Generated code (clients/rust/gen) builds
//! value-free IR requests; this crate compiles them through the wasm engine
//! (cached by IR shape), runs the plan with sqlx and maps positional rows.

pub mod engine;
pub mod ir;
pub mod plan;
pub mod row;
pub mod builder;
pub mod db;
pub mod value;
pub mod codec;
pub mod codes;
pub mod collection;
pub mod config;

pub use builder::{Q, W};
pub use collection::{Collection, Key, Page};
pub use config::OrmConfig;
pub use db::{ConnectOptions, Db, Exec, Pool, Tx};
pub use engine::Engine;
pub use row::{Cells, Src};
pub use value::Param;

/// Every failure surfaces as one of these; engine codes pass through unchanged.
#[derive(Debug)]
pub enum Error {
    /// Compile-time error from the engine (docs/protocol.md §3).
    Engine { code: String, msg: String },
    /// Driver error.
    Sqlx(sqlx::Error),
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
            Error::OptimisticLock => write!(f, "{}: row changed since it was read", codes::OPTIMISTIC_LOCK),
            Error::Config(m) => write!(f, "{}: {m}", codes::CONFIG),
        }
    }
}

impl std::error::Error for Error {}

/// Driver errors: the codes the catalog names (docs/errors.yaml, origin driver) map to a
/// shared code keeping the driver's message — MySQL 1213 / SQLSTATE 40001 → DEADLOCK, 1062 →
/// DUPLICATE_KEY; PostgreSQL 40P01 / 40001 → DEADLOCK, 23505 → DUPLICATE_KEY; SQLite BUSY / LOCKED
/// (5 / 6, primary code of any extended form: the other writer wins, re-run) → DEADLOCK,
/// 2067 / 1555 (CONSTRAINT_UNIQUE / _PRIMARYKEY) → DUPLICATE_KEY. Everything else stays `Error::Sqlx`.
impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        use sqlx::error::DatabaseError as _;
        if let sqlx::Error::Database(d) = &e {
            // (shared code, the driver's message — with the SQLSTATE on PostgreSQL, whose
            // message text is localized, the way pgx renders it)
            let mapped = if let Some(m) = d.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>() {
                match (m.number(), m.code()) {
                    (1213, _) | (_, Some("40001")) => Some((codes::DEADLOCK, m.message().to_owned())),
                    (1062, _) => Some((codes::DUPLICATE_KEY, m.message().to_owned())),
                    _ => None,
                }
            } else if let Some(p) = d.try_downcast_ref::<sqlx::postgres::PgDatabaseError>() {
                let msg = || format!("{} (SQLSTATE {})", p.message(), p.code());
                match p.code() {
                    "40P01" | "40001" => Some((codes::DEADLOCK, msg())),
                    "23505" => Some((codes::DUPLICATE_KEY, msg())),
                    _ => None,
                }
            } else if let Some(s) = d.try_downcast_ref::<sqlx::sqlite::SqliteError>() {
                // sqlx reports the extended result code as text
                let n: i64 = s.code().and_then(|c| c.parse().ok()).unwrap_or(0);
                match (n & 0xff, n) {
                    (5, _) | (6, _) => Some((codes::DEADLOCK, s.message().to_owned())),
                    (_, 2067) | (_, 1555) => Some((codes::DUPLICATE_KEY, s.message().to_owned())),
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
            Error::OptimisticLock => codes::OPTIMISTIC_LOCK,
            Error::Config(_) => codes::CONFIG,
        }
    }

    /// A DEADLOCK mapped at the driver boundary (`From<sqlx::Error>`): MySQL 1213 / 40001,
    /// PostgreSQL 40P01 / 40001, SQLite BUSY / LOCKED.
    pub fn is_deadlock(&self) -> bool {
        self.code() == codes::DEADLOCK
    }

    pub(crate) fn internal(msg: impl Into<String>) -> Error {
        Error::Engine { code: codes::INTERNAL.into(), msg: msg.into() }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
pub use builder::ColRef;
