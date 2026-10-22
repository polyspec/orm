//! The test helper that returns the value of a Result or panics with the message its error gives.

/// Returns the value of an `Ok`, and panics with the message `report` makes of the error otherwise.
pub trait OrPanic<T, E> {
    fn or_panic(self, report: impl FnOnce(E) -> String) -> T;
}

impl<T, E> OrPanic<T, E> for Result<T, E> {
    fn or_panic(self, report: impl FnOnce(E) -> String) -> T {
        match self {
            Ok(value) => value,
            Err(error) => panic!("{}", report(error)),
        }
    }
}
