//! The error kind of a shared recipe case for an error of the core (docs/spec/core.md CORE-3).

use polyspec_orm::{Error, Kind};

/// The kind string that a shared recipe case writes for `kind` (CORE-3).
pub fn code_of_kind(kind: Kind) -> String {
    kind.as_str().to_owned()
}

/// The kind string that a shared recipe case writes for `error` (CORE-3).
pub fn catalog_code(error: &Error) -> String {
    code_of_kind(error.kind())
}

/// The message that a shared recipe case writes for `error`: `<kind>: <text>` (CORE-3, CORE-12).
pub fn catalog_message(error: &Error) -> String {
    error.to_string()
}

/// The kind that a shared recipe case names by `code`, or `None` when `code` is no kind (CORE-3).
pub fn kind_of_code(code: &str) -> Option<Kind> {
    Kind::from_str_exact(code)
}
