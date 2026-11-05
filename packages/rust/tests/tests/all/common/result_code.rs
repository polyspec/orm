//! Converts an ORM result to the code used by coverage assertions.

pub fn code<T>(result: polyspec_orm::Result<T>) -> String {
    match result {
        Ok(_) => "ok".into(),
        Err(error) => error.code().to_owned(),
    }
}
