//! Returns the ORM error code of a result, or "ok" when it succeeded.

pub fn code<T>(result: polyspec_orm::Result<T>) -> String {
    match result {
        Ok(_) => "ok".into(),
        Err(error) => error.code().to_owned(),
    }
}
