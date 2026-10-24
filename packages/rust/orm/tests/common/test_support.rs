//! Shared test doubles and utilities for Rust ORM unit tests.

use std::{borrow::Cow, error::Error as StdError, fmt};

#[path = "../../../tests/tests/common/temp_directory.rs"]
mod temp_directory;

pub(crate) struct Scratch(std::path::PathBuf);

impl Scratch {
    pub(crate) fn new(prefix: &str) -> Self {
        let path = std::env::temp_dir().join(format!("{prefix}-{}", std::process::id()));
        if let Err(error) = std::fs::remove_dir_all(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                panic!("remove {}: {error}", path.display());
            }
        }
        std::fs::create_dir_all(&path).expect("create test directory");
        Scratch(path)
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

pub(crate) fn manifest(source: &str) -> crate::schema::Manifest {
    let document = crate::dbspec::parse(source, &Default::default()).unwrap().document;
    let set = crate::dbspec::manifest(&[&document]).unwrap();
    crate::schema::Manifest::load(&set.manifest_text, &set.manifest_hash).unwrap()
}
