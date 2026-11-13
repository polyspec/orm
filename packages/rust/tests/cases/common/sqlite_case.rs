//! The bench schema of contracts/fixtures/bench/bench.dbs, and a SQLite file of a test case with that schema installed.
//! sqlite_concurrency, transaction_flow, val_text and soft_delete use them.

use std::path::PathBuf;
use std::sync::LazyLock;

use polyspec_orm::{Db, Schema};

/// The manifest of contracts/fixtures/bench/bench.dbs alone, with its text and its hash: the document carries comments, which
/// its manifest text leaves out, so the document text itself is not the manifest text, and the hash is the one the manifest
/// states, never a copy that a change of the fixture would leave behind.
static MANIFEST: LazyLock<(String, String)> = LazyLock::new(|| {
    let text = include_str!("../../../../../contracts/fixtures/bench/bench.dbs");
    let document = polyspec_orm::dbspec::parse(text, &Default::default()).expect("bench.dbs parses").document;
    let manifest = polyspec_orm::dbspec::manifest(&[&document]).expect("the manifest of bench.dbs");
    (manifest.manifest_text, manifest.manifest_hash)
});

/// The manifest text of contracts/fixtures/bench/bench.dbs alone.
#[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
pub static MANIFEST_TEXT: LazyLock<String> = LazyLock::new(|| MANIFEST.0.clone());

#[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
pub static SCHEMA: LazyLock<Schema> = LazyLock::new(|| Schema::new(&MANIFEST.0, &MANIFEST.1));

/// A new SQLite file with the schema installed, in a directory of its own for one test. The directory is removed
/// when the value is dropped, also when the test fails an assertion and unwinds.
#[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
pub struct Database {
    pub dsn: String,
    pub dir: PathBuf,
}

impl Drop for Database {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.dir) {
            if !std::thread::panicking() {
                panic!("remove {}: {error}", self.dir.display());
            }
        }
    }
}

/// The database of the case `name` of the test file whose directory is named `prefix`.
#[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
pub async fn database(prefix: &str, name: &str) -> Database {
    let dir = std::env::temp_dir().join(format!("orm-rust-{prefix}-{}-{name}", std::process::id()));
    if let Err(error) = std::fs::remove_dir_all(&dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            panic!("remove {}: {error}", dir.display());
        }
    }
    std::fs::create_dir_all(&dir).unwrap();
    let dsn = format!("sqlite://{}", dir.join(format!("{name}.sqlite")).display());
    let db = Db::connect(&dsn, 1, polyspec_orm::Config::default()).await.unwrap();
    db.utils().schema().install(&SCHEMA).await.unwrap();
    db.close().await;
    Database { dsn, dir }
}
