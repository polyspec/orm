//! The error code of a shared recipe case for an error of the core (docs/spec/core.md CORE-3).

use polyspec_orm::{Error, Kind};

/// The code that a shared recipe case writes for `kind`: the kind in capitals (CORE-3).
pub fn code_of_kind(kind: Kind) -> String {
    kind.as_str().to_ascii_uppercase()
}

/// The code that a shared recipe case writes for `error` (CORE-3).
pub fn catalog_code(error: &Error) -> String {
    code_of_kind(error.kind())
}

/// The message that a shared recipe case writes for `error`: `<CODE>: <text>`, whose code is the kind in capitals (CORE-3).
pub fn catalog_message(error: &Error) -> String {
    let message = error.to_string();
    let kind = error.kind().as_str();
    match message.strip_prefix(kind) {
        Some(rest) => format!("{}{rest}", code_of_kind(error.kind())),
        None => message,
    }
}

/// The kind that a shared recipe case names by `code`, or `None` when `code` is no kind in capitals (CORE-3).
pub fn kind_of_code(code: &str) -> Option<Kind> {
    Kind::ALL.into_iter().find(|kind| code_of_kind(*kind) == code)
}
