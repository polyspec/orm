//! Shared test doubles for errors returned by the SQLx driver.

macro_rules! impl_database_error {
    ($error:ty, $this:ident, $message:block, $code:block) => {
        impl sqlx::error::DatabaseError for $error {
            fn message(&$this) -> &str $message

            fn code(&$this) -> Option<std::borrow::Cow<'_, str>> $code

            fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
                self
            }

            fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
                self
            }

            fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
                self
            }

            fn kind(&self) -> sqlx::error::ErrorKind {
                sqlx::error::ErrorKind::Other
            }
        }
    };
}

pub(crate) use impl_database_error;
