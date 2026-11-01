//! Reads the required seeded benchmark DSN for the Rust examples.

/// Returns the seeded benchmark DSN or reports why the program cannot run.
pub fn dsn() -> String {
    match std::env::var("ORM_BENCH_MYSQL_DSN") {
        Ok(value) if !value.is_empty() => value,
        Ok(_) | Err(std::env::VarError::NotPresent) => {
            eprintln!("ORM_BENCH_MYSQL_DSN is required; it names the seeded bench database; run it through make orm-check or make run-databases TARGETS=<target>, which create the bench database of the run");
            std::process::exit(1)
        }
        Err(error) => {
            eprintln!("ORM_BENCH_MYSQL_DSN must be UTF-8: {error}");
            std::process::exit(1)
        }
    }
}
