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
pub use db::{Db, Exec, Tx};
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

/// Driver errors: the listed MySQL codes map to a shared code (docs/errors.yaml, origin
/// driver) keeping the driver's message; everything else stays `Error::Sqlx`.
impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        if let sqlx::Error::Database(d) = &e {
            let (number, state) = match d.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>() {
                Some(m) => (Some(m.number()), m.code().map(str::to_owned)),
                None => (None, d.code().map(|c| c.into_owned())),
            };
            let state = state.as_deref();
            let code = match (number, state) {
                (Some(1213), _) | (None, Some("40001")) => Some(codes::DEADLOCK),
                (Some(1062), _) | (None, Some("23000")) => Some(codes::DUPLICATE_KEY),
                _ => None,
            };
            if let Some(code) = code {
                return Error::Engine { code: code.into(), msg: d.message().to_owned() };
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

    /// MySQL 1213 / SQLSTATE 40001, mapped at the driver boundary (`From<sqlx::Error>`).
    pub fn is_deadlock(&self) -> bool {
        self.code() == codes::DEADLOCK
    }

    pub(crate) fn internal(msg: impl Into<String>) -> Error {
        Error::Engine { code: codes::INTERNAL.into(), msg: msg.into() }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
pub use builder::ColRef;
