//! Shared SQLite paths and dialect DSNs for physical grid and tool tests.

use std::{
    future::Future,
    path::{Path, PathBuf},
    time::Duration,
};

/// Returns an unowned, process-scoped SQLite fixture path for one physical test.
pub fn sqlite_path(stem: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("orm-{stem}-{}.sqlite", std::process::id()));
    assert!(!path.exists(), "SQLite fixture path must be unowned before this run: {}", path.display());
    path
}

/// Returns a DSN for one physical test database, keeping SQLite isolated to its supplied path.
pub fn dsn_for(dialect: &str, sqlite_path: &Path) -> String {
    match dialect {
        "sqlite" => format!("sqlite://{}", sqlite_path.display()),
        "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").expect("MySQL fixture DSN"),
        "postgres" => std::env::var("ORM_TOOLS_POSTGRES_DSN").expect("PostgreSQL fixture DSN"),
        _ => panic!("unsupported physical test dialect: {dialect}"),
    }
}

/// Drops the supplied connection, closes the database, then records the dialect step in that order.
pub async fn finish_physical_dialect<C>(database: polyspec_orm::Db, connection: C, dialect: &str, result: &str) {
    drop(connection);
    database.close().await;
    polyspec_orm_testcase::step(format_args!("{dialect} {result}"));
}

/// Waits for a physical test's future without moving its case guard out of the test function.
#[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
pub async fn within<F: Future<Output = ()>>(seconds: u64, deadline: &str, future: F) {
    tokio::time::timeout(Duration::from_secs(seconds), future).await.expect(deadline);
}
