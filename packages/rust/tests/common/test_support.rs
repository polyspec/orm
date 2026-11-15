//! Shared test doubles and utilities for Rust ORM unit tests.

use std::{
    borrow::Cow,
    error::Error as StdError,
    fmt,
    sync::atomic::{AtomicU64, Ordering},
};

use polyspec_orm_test_support::temp_directory;

pub(crate) struct Scratch(std::path::PathBuf);

impl Scratch {
    pub(crate) fn new(prefix: &str) -> Self {
        static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir();
        loop {
            let id = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
            let path = root.join(format!("{prefix}-{}-{id}", std::process::id()));
            match std::fs::create_dir(&path) {
                Ok(()) => return Scratch(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create {}: {error}", path.display()),
            }
        }
    }

    pub(crate) fn join(&self, name: &str) -> std::path::PathBuf {
        self.0.join(name)
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        temp_directory::remove_on_drop(&self.0);
    }
}

#[derive(Debug)]
pub(crate) struct DatabaseErrorStub {
    display: String,
    message: String,
    code: Option<String>,
}

impl DatabaseErrorStub {
    pub(crate) fn new(display: impl Into<String>, message: impl Into<String>, code: Option<String>) -> Self {
        Self { display: display.into(), message: message.into(), code }
    }
}

impl fmt::Display for DatabaseErrorStub {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.display)
    }
}

impl StdError for DatabaseErrorStub {}

impl sqlx::error::DatabaseError for DatabaseErrorStub {
    fn message(&self) -> &str {
        &self.message
    }

    fn code(&self) -> Option<Cow<'_, str>> {
        self.code.as_deref().map(|code| Cow::Owned(code.to_owned()))
    }

    fn as_error(&self) -> &(dyn StdError + Send + Sync + 'static) {
        self
    }

    fn as_error_mut(&mut self) -> &mut (dyn StdError + Send + Sync + 'static) {
        self
    }

    fn into_error(self: Box<Self>) -> Box<dyn StdError + Send + Sync + 'static> {
        self
    }

    fn kind(&self) -> sqlx::error::ErrorKind {
        sqlx::error::ErrorKind::Other
    }
}

#[cfg(test)]
#[path = "../unit/scratch.rs"]
mod scratch_tests;
