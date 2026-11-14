//! Shared SQLite paths and dialect DSNs for physical grid and tool tests.

pub use polyspec_orm_test_support::fixture_dsn::{fixture_dsn, server_dsn};
use std::path::{Path, PathBuf};

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
        "mysql" => server_dsn("ORM_TOOLS_MYSQL_DSN"),
        "postgres" => server_dsn("ORM_TOOLS_POSTGRES_DSN"),
        _ => panic!("unsupported physical test dialect: {dialect}"),
    }
}

/// A missing fixture DSN names its variable and the target that writes it.
fn fixture_dsn_names_the_missing_variable_and_its_remedy() {
    let _case = polyspec_orm_testcase::case!();
    assert_eq!(fixture_dsn("ORM_TOOLS_MYSQL_DSN", Some("mysql://u@h/d".to_owned())), Ok("mysql://u@h/d".to_owned()));
    let remedy = "is required; run make orm-test-servers, which starts the databases and writes it";
    for variable in ["ORM_TOOLS_MYSQL_DSN", "ORM_TOOLS_POSTGRES_DSN"] {
        for value in [None, Some(String::new())] {
            assert_eq!(fixture_dsn(variable, value), Err(format!("{variable} {remedy}")));
        }
    }
}

/// The trials of the fixture helpers.
pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("physical_fixture": fixture_dsn_names_the_missing_variable_and_its_remedy)
}

/// Drops the supplied connection, closes the database, then records the dialect step in that order.
pub async fn finish_physical_dialect<C>(database: polyspec_orm::Db, connection: C, dialect: &str, result: &str) {
    drop(connection);
    database.close().await;
    polyspec_orm_testcase::step(format_args!("{dialect} {result}"));
}
