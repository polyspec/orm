//! Rust executor for the orm engine. Generated code (clients/rust/gen) builds
//! value-free IR requests; this crate compiles them through the wasm engine
//! (cached by IR shape), runs the plan with sqlx and maps positional rows.

pub mod engine;
pub mod ir;
pub mod plan;
pub mod builder;
pub mod db;
pub mod value;
pub mod codec;
pub mod collection;

pub use builder::{Q, W};
pub use collection::{Collection, Key, Page};
pub use db::{Db, Exec, Tx};
pub use engine::Engine;
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
            Error::OptimisticLock => write!(f, "OPTIMISTIC_LOCK: row changed since it was read"),
            Error::Config(m) => write!(f, "CONFIG: {m}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        Error::Sqlx(e)
    }
}

impl Error {
    pub fn code(&self) -> &str {
        match self {
            Error::Engine { code, .. } => code,
            Error::Sqlx(_) => "SQLX",
            Error::OptimisticLock => "OPTIMISTIC_LOCK",
            Error::Config(_) => "CONFIG",
        }
    }

    pub fn is_deadlock(&self) -> bool {
        match self {
            Error::Sqlx(e) => {
                let s = e.to_string();
                s.contains("1213") || s.contains("40001") || s.to_lowercase().contains("deadlock")
            }
            _ => false,
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
