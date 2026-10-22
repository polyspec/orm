//! The SQLite fixture file of a grid test (KSTD-5-46): one path per test, which must not exist yet.

use std::path::PathBuf;

/// The SQLite fixture file of the grid test `stem`, in the temporary directory; it must not exist yet.
pub fn fixture_path(stem: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("orm-{stem}-{}.sqlite", std::process::id()));
    assert!(!path.exists());
    path
}
