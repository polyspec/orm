//! Converts an ORM result to the code used by coverage assertions.

pub fn code<T>(result: polyspec_orm::Result<T>) -> String {
    match result {
        Ok(_) => "ok".into(),
        Err(error) => polyspec_orm_test_support::catalog_code::catalog_code(&error),
    }
}
