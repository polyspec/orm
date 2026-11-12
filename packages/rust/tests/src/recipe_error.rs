//! The codes of errors in the shared recipe cases (docs/spec/core.md CORE-3).
//!
//! A recipe case writes the code of the error catalog in capitals; an error of the core has a kind, which the runner
//! writes in capitals. The runner itself reports a failure of the language code of a case, such as a failing callback,
//! with a code that is no kind (`CALLBACK`, `STEP`). It makes such an error as a `config` error whose text starts with
//! [`RUNNER`] and the code, and reads the code back from that text.

use polyspec_orm::{Error, Kind};

/// The head of the text of an error that the runner makes for a code that is no kind.
pub const RUNNER: &str = "recipe runner ";

/// The error of the code `code` of a recipe case and the text `message`: an error of the kind that `code` writes in
/// capitals, or a runner error for a code that is no kind.
pub fn error_of_code(code: &str, message: impl Into<String>) -> Error {
    match polyspec_orm_test_support::catalog_code::kind_of_code(code) {
        Some(kind) => Error::new(kind, message),
        None => runner_error(code, message),
    }
}

/// The runner error of `code`, which is no kind, and the text `message`.
pub fn runner_error(code: &str, message: impl Into<String>) -> Error {
    Error::new(Kind::Config, format!("{RUNNER}{code}: {}", message.into()))
}

/// The code and the message of an error as a recipe case writes them (CORE-3).
pub trait RecipeCode {
    /// The code: the kind in capitals, or the code of a runner error.
    fn code(&self) -> String;
    /// The message: `<CODE>: <text>`.
    fn recipe_message(&self) -> String;
}

impl RecipeCode for Error {
    fn code(&self) -> String {
        match runner_parts(self) {
            Some((code, _)) => code.to_owned(),
            None => polyspec_orm_test_support::catalog_code::catalog_code(self),
        }
    }

    fn recipe_message(&self) -> String {
        match runner_parts(self) {
            Some((code, text)) => format!("{code}: {text}"),
            None => polyspec_orm_test_support::catalog_code::catalog_message(self),
        }
    }
}

fn runner_parts(error: &Error) -> Option<(&str, &str)> {
    if error.kind() != Kind::Config {
        return None;
    }
    error.text().strip_prefix(RUNNER)?.split_once(": ")
}
