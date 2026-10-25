//! Creates and removes a private SQLite file for a database-independent client test.
use std::fs::{self, File};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct TempSqlite(PathBuf);

impl TempSqlite {
    pub fn create(prefix: &str) -> Self {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).expect("system clock").as_nanos();
        let path = std::env::temp_dir().join(format!("{prefix}-{}-{nonce}.sqlite", std::process::id()));
        File::options().write(true).create_new(true).open(&path).expect("create private SQLite fixture");
        Self(path)
    }

    pub fn dsn(&self) -> String {
        format!("sqlite://{}", self.0.display())
    }
}

impl Drop for TempSqlite {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.0) {
            if error.kind() == std::io::ErrorKind::NotFound {
                return;
            }
            if std::thread::panicking() {
                eprintln!("could not remove SQLite fixture {} while unwinding: {error}", self.0.display());
            } else {
                panic!("could not remove SQLite fixture {}: {error}", self.0.display());
            }
        }
    }
}
