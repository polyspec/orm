//! Runs a grid fixture case once on each physical database.

/// Runs one case on each supported database with one owned SQLite file.
macro_rules! for_physical_dialects {
    ($name:expr, |$dialect:ident, $dsn:ident, $failures:ident| $body:block) => {{
        let path = $crate::physical_fixture::sqlite_path($name);
        let mut failures = Vec::new();
        let $failures = &mut failures;
        for $dialect in ["sqlite", "mysql", "postgres"] {
            polyspec_orm_testcase::step(format_args!("running {}", $dialect));
            let $dsn = $crate::physical_fixture::dsn_for($dialect, &path);
            $body
        }
        std::fs::remove_file(path).expect("remove owned SQLite fixture");
        failures
    }};
}
