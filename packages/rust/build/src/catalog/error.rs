//! The error of a catalog operation.

/// The error of a catalog operation: its message, whose head is the code of the error, and the failure of the driver or of a
/// library that caused it, kept as its source (INT-172).
#[derive(Debug)]
pub struct CatalogError {
    message: String,
    source: Option<Box<dyn std::error::Error + Send + Sync + 'static>>,
}

impl CatalogError {
    /// An error with its cause.
    pub fn caused(message: impl Into<String>, source: impl Into<Box<dyn std::error::Error + Send + Sync + 'static>>) -> Self {
        Self { message: message.into(), source: Some(source.into()) }
    }
    /// The whole message, its code included.
    pub fn message(&self) -> &str {
        &self.message
    }
    /// The code at the head of the message.
    pub fn code(&self) -> &str {
        self.message.split_once(':').map_or(self.message.as_str(), |(code, _)| code)
    }
    /// The same error with another message, which keeps its cause.
    pub(crate) fn with_message(self, message: String) -> Self {
        Self { message, source: self.source }
    }
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CatalogError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source.as_deref().map(|source| source as &(dyn std::error::Error + 'static))
    }
}

impl From<String> for CatalogError {
    fn from(message: String) -> Self {
        Self { message, source: None }
    }
}

impl From<&str> for CatalogError {
    fn from(message: &str) -> Self {
        Self { message: message.to_owned(), source: None }
    }
}
