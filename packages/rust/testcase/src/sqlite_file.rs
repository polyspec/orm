use std::path::PathBuf;

/// An owned SQLite test file removed when the guard is dropped.
pub struct SqliteFile(PathBuf);

impl SqliteFile {
    /// Guards a path that must not exist before the test creates its database.
    pub fn own(path: PathBuf, message: &str) -> Self {
        assert!(!path.exists(), "{message}");
        Self(path)
    }

    /// Removes any previous fixture at `path`, then guards the file created by the test.
    pub fn fresh(path: PathBuf) -> Self {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound {
                    panic!("remove the database file {}: {error}", path.display());
                }
            }
        }
        Self(path)
    }
}

impl Drop for SqliteFile {
    fn drop(&mut self) {
        match std::fs::remove_file(&self.0) {
            Ok(()) => {}
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound {
                    if std::thread::panicking() {
                        eprintln!("remove the database file {}: {error}", self.0.display());
                    } else {
                        panic!("remove the database file {}: {error}", self.0.display());
                    }
                }
            }
        }
    }
}
