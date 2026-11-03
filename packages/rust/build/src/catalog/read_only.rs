use sqlparser::{
    dialect::{Dialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect},
    tokenizer::{Token, Tokenizer, Whitespace},
};

/// The keywords that a read query never uses as a statement or clause, as the other runtimes hold them. A query is read by
/// its tokens and no tree is built, so its length and its nesting are no reason to refuse it.
const WRITE_WORDS: [&str; 26] = [
    "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "CREATE", "DROP", "ALTER", "TRUNCATE", "RENAME", "GRANT", "REVOKE", "CALL", "DO", "INTO",
    "LOCK", "SHARE", "PROCEDURE", "LOAD", "COPY", "ATTACH", "DETACH", "PRAGMA", "VACUUM", "REINDEX", "ANALYZE",
];

#[derive(Debug)]
pub(super) struct ReadOnlyError {
    cause: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl std::fmt::Display for ReadOnlyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("QUERY_READ_ONLY: expected one supported non-locking read query")
    }
}

impl std::error::Error for ReadOnlyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause.as_deref().map(|cause| cause as &(dyn std::error::Error + 'static))
    }
}

pub(super) fn validate(sql: &str, dialect: &str) -> Result<(), ReadOnlyError> {
    if sql.is_empty() {
        return Err(error());
    }
    let dialect: Box<dyn Dialect> = match dialect {
        "mysql" => Box::new(MySqlDialect {}),
        "postgres" => Box::new(PostgreSqlDialect {}),
        "sqlite" => Box::new(SQLiteDialect {}),
        _ => return Err(error()),
    };
    let tokens = Tokenizer::new(dialect.as_ref(), sql).tokenize().map_err(error_with)?;
    let mut words = Vec::new();
    for token in &tokens {
        match token {
            Token::Whitespace(Whitespace::MultiLineComment(comment)) if comment.starts_with('!') || comment.starts_with("M!") => return Err(error()),
            Token::Word(word) if word.quote_style.is_none() => words.push(word.value.to_ascii_uppercase()),
            Token::SemiColon => words.push(";".to_owned()),
            _ => {}
        }
    }
    if !matches!(words.first().map(String::as_str), Some("SELECT" | "WITH" | "VALUES")) {
        return Err(error());
    }
    for (index, word) in words.iter().enumerate() {
        // Only one trailing semicolon is allowed; anything after it would be a second statement.
        if (word == ";" && index + 1 != words.len()) || WRITE_WORDS.contains(&word.as_str()) {
            return Err(error());
        }
    }
    Ok(())
}
fn error() -> ReadOnlyError {
    ReadOnlyError { cause: None }
}

fn error_with(error: impl std::error::Error + Send + Sync + 'static) -> ReadOnlyError {
    ReadOnlyError { cause: Some(Box::new(error)) }
}

#[cfg(test)]
#[path = "../../tests/unit/read_only_policy.rs"]
mod tests;
