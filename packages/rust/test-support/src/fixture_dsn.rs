//! The DSN of a MySQL or PostgreSQL fixture, which the run gives in an environment variable. The test targets of the build
//! crate and of its cases crate read it here, so neither names a file of the other by `#[path]`.

/// The DSN that the environment variable `variable` holds for a MySQL or PostgreSQL fixture; a test without it fails with
/// the message of `fixture_dsn`.
pub fn server_dsn(variable: &str) -> String {
    // A variable that is absent is the case that fixture_dsn names; a variable whose value is no Unicode text is another
    // failure, which names the value that was found.
    let value = match std::env::var(variable) {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(found)) => panic!("{variable} holds a value that is no Unicode text: {found:?}"),
    };
    match fixture_dsn(variable, value) {
        Ok(dsn) => dsn,
        Err(message) => panic!("{message}"),
    }
}

/// The DSN of a fixture from `value`, the value of the environment variable `variable`, or, when the variable is unset or
/// empty, the message that names the variable and how to provide it.
pub fn fixture_dsn(variable: &str, value: Option<String>) -> Result<String, String> {
    match value {
        Some(dsn) if !dsn.is_empty() => Ok(dsn),
        _ => Err(format!("{variable} is required; run make orm-test-servers, which starts the databases and writes it")),
    }
}
