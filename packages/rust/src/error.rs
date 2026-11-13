//! The error of the core (docs/spec/core.md CORE-10 to CORE-14, CORE-25, docs/spec/errors.md).

use crate::kind::Kind;
use binding_core::{Category, Failure, Kinds};
use std::fmt;

/// The failure of a callback that a rollback failure carries unopened (CORE-25): an error of orm, or the exception of
/// the language that the generated binding holds (bindgen design E-1c, U-3).
pub type CallbackFailure = Failure<Error>;

/// What a failure keeps besides its kind and message.
#[derive(Debug)]
enum Detail {
    None,
    /// The callback failed and the rollback failed too (CORE-25).
    RollbackFailed {
        callback: Box<CallbackFailure>,
        rollback: Box<Error>,
    },
    /// An operation failed and one or more of its cleanup steps failed too; the error keeps the kind of the operation.
    Cleanup {
        primary: Box<Error>,
        cleanup: Vec<Error>,
    },
}

/// The cause of an error.
#[derive(Debug)]
enum Source {
    None,
    /// The error of the driver (CORE-13).
    Driver(sqlx::Error),
    /// Another library failure under the error, such as the failure under a codec stage text (COD-41).
    Other(Box<dyn std::error::Error + Send + Sync + 'static>),
}

/// An error of the core: one kind of the closed enum [`Kind`] and a message (CORE-10, CORE-12).
#[derive(Debug)]
pub struct Error {
    kind: Kind,
    message: String,
    source: Source,
    detail: Detail,
}

impl Error {
    /// An error of `kind` with the text of its message (CORE-12).
    #[must_use]
    pub fn new(kind: Kind, message: impl Into<String>) -> Error {
        Error { kind, message: message.into(), source: Source::None, detail: Detail::None }
    }

    /// An error of `kind` with the failure that caused it.
    #[must_use]
    pub fn with_source(kind: Kind, message: impl Into<String>, source: Box<dyn std::error::Error + Send + Sync + 'static>) -> Error {
        Error { kind, message: message.into(), source: Source::Other(source), detail: Detail::None }
    }

    /// An error of `kind` with an optional cause.
    pub(crate) fn with_optional_source(kind: Kind, message: impl Into<String>, source: Option<Box<dyn std::error::Error + Send + Sync + 'static>>) -> Error {
        match source {
            Some(source) => Error::with_source(kind, message, source),
            None => Error::new(kind, message),
        }
    }

    /// An error of the driver with the kind of its code and the driver error as its cause (CORE-13).
    pub(crate) fn driver(kind: Kind, message: impl Into<String>, source: sqlx::Error) -> Error {
        Error { kind, message: message.into(), source: Source::Driver(source), detail: Detail::None }
    }

    /// A `config` error.
    #[must_use]
    pub fn config(message: impl Into<String>) -> Error {
        Error::new(Kind::Config, message)
    }

    /// An `internal` error: a broken invariant of the core (P-4 of the plan, CORE-26).
    #[must_use]
    pub fn internal(message: impl Into<String>) -> Error {
        Error::new(Kind::Internal, message)
    }

    /// The `no_rows` error of a strict one-row query that matched no row.
    #[must_use]
    pub fn no_rows() -> Error {
        Error::new(Kind::NoRows, "query returned no rows")
    }

    /// The `optimistic_lock` error of an optimistic update that matched no row.
    #[must_use]
    pub fn optimistic_lock() -> Error {
        Error::new(Kind::OptimisticLock, "row changed since it was read")
    }

    /// The `rollback_failed` error of a callback that failed and whose rollback failed too (CORE-25). Its message
    /// names the failure of the rollback alone: the failure of the callback stays unopened in `callback_error`.
    #[must_use]
    pub fn rollback_failed(callback: CallbackFailure, rollback: Error) -> Error {
        Error {
            kind: Kind::RollbackFailed,
            message: format!("the rollback failed after the callback failed: {rollback}"),
            source: Source::None,
            detail: Detail::RollbackFailed { callback: Box::new(callback), rollback: Box::new(rollback) },
        }
    }

    /// The `rollback_failed` error of a callback that failed with an error of orm.
    pub(crate) fn rollback_failed_of(callback: Error, rollback: Error) -> Error {
        Error::rollback_failed(CallbackFailure::Kind(callback), rollback)
    }

    /// The error of an operation `primary` whose cleanup steps failed with `cleanup`: it keeps the kind and the message
    /// of the operation.
    #[must_use]
    pub fn cleanup(primary: Error, cleanup: Vec<Error>) -> Error {
        Error { kind: primary.kind, message: primary.message.clone(), source: Source::None, detail: Detail::Cleanup { primary: Box::new(primary), cleanup } }
    }

    /// The kind of the error (CORE-10).
    #[must_use]
    pub const fn kind(&self) -> Kind {
        self.kind
    }

    /// The category of the kind (CORE-11).
    #[must_use]
    pub const fn category(&self) -> Category {
        self.kind.category()
    }

    /// The text of the message after `<kind>: ` (CORE-12).
    #[must_use]
    pub fn text(&self) -> &str {
        &self.message
    }

    /// The failure of the callback that a `rollback_failed` error carries (CORE-25), or `None` for any other error.
    #[must_use]
    pub fn callback_error(&self) -> Option<&CallbackFailure> {
        match &self.detail {
            Detail::RollbackFailed { callback, .. } => Some(callback),
            Detail::None | Detail::Cleanup { .. } => None,
        }
    }

    /// The error of the rollback that a `rollback_failed` error carries (CORE-25), or `None` for any other error.
    #[must_use]
    pub fn rollback_error(&self) -> Option<&Error> {
        match &self.detail {
            Detail::RollbackFailed { rollback, .. } => Some(rollback),
            Detail::None | Detail::Cleanup { .. } => None,
        }
    }

    /// The failed cleanup steps of an operation, empty for an error without them.
    #[must_use]
    pub fn cleanup_errors(&self) -> &[Error] {
        match &self.detail {
            Detail::Cleanup { cleanup, .. } => cleanup,
            Detail::None | Detail::RollbackFailed { .. } => &[],
        }
    }

    /// The operation error under failed cleanup steps, or `None` for an error without them.
    #[must_use]
    pub fn cleanup_primary(&self) -> Option<&Error> {
        match &self.detail {
            Detail::Cleanup { primary, .. } => Some(primary),
            Detail::None | Detail::RollbackFailed { .. } => None,
        }
    }

    /// The error of the driver that caused the error, or `None`.
    #[must_use]
    pub fn driver_error(&self) -> Option<&sqlx::Error> {
        match &self.source {
            Source::Driver(error) => Some(error),
            Source::None | Source::Other(_) => None,
        }
    }

    /// Whether the kind is `deadlock`, the kind that a transaction retries (CORE-24).
    #[must_use]
    pub fn is_deadlock(&self) -> bool {
        self.kind == Kind::Deadlock
    }

    /// The same error with another kind and its message, keeping its cause.
    pub(crate) fn rekind(self, kind: Kind) -> Error {
        Error { kind, ..self }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.detail {
            Detail::Cleanup { primary, cleanup } => {
                write!(f, "{primary} (cleanup failed: ")?;
                for (index, error) in cleanup.iter().enumerate() {
                    if index > 0 {
                        f.write_str("; ")?;
                    }
                    write!(f, "{error}")?;
                }
                f.write_str(")")
            }
            Detail::None | Detail::RollbackFailed { .. } => write!(f, "{}: {}", self.kind, self.message),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match (&self.detail, &self.source) {
            (Detail::Cleanup { primary, .. }, _) => Some(primary.as_ref()),
            (Detail::RollbackFailed { rollback, .. }, _) => Some(rollback.as_ref()),
            (Detail::None, Source::Driver(error)) => Some(error),
            (Detail::None, Source::Other(error)) => Some(error.as_ref()),
            (Detail::None, Source::None) => None,
        }
    }
}

impl Kinds for Error {
    fn kind(&self) -> &'static str {
        self.kind.as_str()
    }

    fn status(&self) -> Option<u16> {
        None
    }

    fn errno(&self) -> Option<i32> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{CallbackFailure, Error};
    use crate::kind::Kind;

    // Requirements: CORE-12.
    #[test]
    fn the_message_is_the_kind_and_the_text() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        assert_eq!(Error::no_rows().to_string(), "no_rows: query returned no rows");
        assert_eq!(Error::new(Kind::Busy, "x").to_string(), "busy: x");
    }

    // Requirements: CORE-25.
    #[test]
    fn a_failed_rollback_keeps_the_callback_failure_unopened() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let error = Error::rollback_failed(CallbackFailure::Kind(Error::new(Kind::Deadlock, "first")), Error::new(Kind::ConnectionLost, "gone"));
        assert_eq!(error.kind(), Kind::RollbackFailed);
        assert_eq!(error.to_string(), "rollback_failed: the rollback failed after the callback failed: connection_lost: gone");
        assert!(matches!(error.callback_error(), Some(CallbackFailure::Kind(callback)) if callback.kind() == Kind::Deadlock));
        assert!(matches!(error.rollback_error(), Some(rollback) if rollback.kind() == Kind::ConnectionLost));
    }

    #[test]
    fn a_cleanup_failure_keeps_the_kind_of_the_operation() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let error = Error::cleanup(Error::new(Kind::Driver, "a"), vec![Error::new(Kind::ConnectionLost, "b")]);
        assert_eq!(error.kind(), Kind::Driver);
        assert_eq!(error.to_string(), "driver: a (cleanup failed: connection_lost: b)");
        assert_eq!(error.cleanup_errors().len(), 1);
    }
}
