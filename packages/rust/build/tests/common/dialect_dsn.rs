//! The DSN of a dialect of the tool tests: the SQLite file of the case, or the MySQL and PostgreSQL fixtures of the environment.

/// The DSN of `dialect` (`sqlite`, `mysql` or `postgres`); the SQLite file is `sqlite_path`.
#[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
pub fn dsn_for(dialect: &str, sqlite_path: &std::path::Path) -> String {
    match dialect {
        "sqlite" => format!("sqlite://{}", sqlite_path.display()),
        "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").expect("MySQL fixture DSN"),
        _ => std::env::var("ORM_TOOLS_POSTGRES_DSN").expect("PostgreSQL fixture DSN"),
    }
}
