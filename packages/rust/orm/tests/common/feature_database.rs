//! Reads the database selected by feature-check.

pub fn selected() -> &'static str {
    match std::env::var("ORM_FEATURE_DATABASE").as_deref() {
        Ok("mysql") => "mysql",
        Ok("postgres") => "postgres",
        Ok("sqlite") => "sqlite",
        _ => panic!("ORM_FEATURE_DATABASE (mysql, postgres or sqlite) is required; run it through make feature-check, which sets it for each coverage case"),
    }
}

/// Reads the selected database and its required DSN without imposing an empty-value policy.
pub fn selected_and_dsn() -> (&'static str, String) {
    let driver = selected();
    let dsn = std::env::var("ORM_FEATURE_DSN").expect("ORM_FEATURE_DSN is required; run it through make feature-check, which sets it for each coverage case");
    (driver, dsn)
}

#[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses the DSN")]
pub fn selected_dsn() -> (&'static str, String) {
    let (driver, dsn) = selected_and_dsn();
    assert!(!dsn.is_empty());
    (driver, dsn)
}
