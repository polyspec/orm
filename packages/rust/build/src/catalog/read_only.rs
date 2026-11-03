use sqlparser::{
    ast::{Query, Select, SetExpr, Statement, Visit, Visitor},
    dialect::{Dialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect},
    parser::Parser,
    tokenizer::{Token, Tokenizer, Whitespace},
};
use std::ops::ControlFlow;

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

/// The stack of the walk of one statement. A chain of operands parses into a left-deep tree, which the visitor and the drop
/// of the tree walk by recursion; the length bound of a statement keeps it under 128 Ki levels. Only what the walk touches is
/// committed, so this is an address range and not memory in use.
const WALK_STACK: usize = 512 * 1024 * 1024;

pub(super) fn validate(sql: &str, dialect: &str) -> Result<(), ReadOnlyError> {
    std::thread::scope(|scope| {
        let walk = std::thread::Builder::new().stack_size(WALK_STACK).spawn_scoped(scope, || validate_statement(sql, dialect));
        walk.map_err(error_with)?.join().unwrap_or_else(|_| Err(error()))
    })
}

fn validate_statement(sql: &str, dialect: &str) -> Result<(), ReadOnlyError> {
    if sql.is_empty() || sql.len() > 256 * 1024 {
        return Err(error());
    }
    let dialect: Box<dyn Dialect> = match dialect {
        "mysql" => Box::new(MySqlDialect {}),
        "postgres" => Box::new(PostgreSqlDialect {}),
        "sqlite" => Box::new(SQLiteDialect {}),
        _ => return Err(error()),
    };
    let tokens = Tokenizer::new(dialect.as_ref(), sql).tokenize().map_err(error_with)?;
    if tokens
        .iter()
        .any(|token| matches!(token,Token::Whitespace(Whitespace::MultiLineComment(comment)) if comment.starts_with('!')||comment.starts_with("M!")))
    {
        return Err(error());
    }
    let statements = Parser::new(dialect.as_ref()).with_recursion_limit(64).with_tokens(tokens).parse_statements().map_err(error_with)?;
    if statements.len() != 1 || !matches!(statements[0], Statement::Query(_)) || statements.visit(&mut ReadOnly).is_break() {
        return Err(error());
    }
    Ok(())
}
fn error() -> ReadOnlyError {
    ReadOnlyError { cause: None }
}

fn error_with(error: impl std::error::Error + Send + Sync + 'static) -> ReadOnlyError {
    ReadOnlyError { cause: Some(Box::new(error)) }
}

struct ReadOnly;

fn body_allowed(body: &SetExpr) -> bool {
    let mut pending = vec![body];
    while let Some(body) = pending.pop() {
        match body {
            SetExpr::Select(_) | SetExpr::Values(_) | SetExpr::Query(_) => {}
            SetExpr::SetOperation { left, right, .. } => {
                pending.push(left);
                pending.push(right);
            }
            _ => return false,
        }
    }
    true
}
impl Visitor for ReadOnly {
    type Break = ();
    fn pre_visit_statement(&mut self, statement: &Statement) -> ControlFlow<()> {
        if matches!(statement, Statement::Query(_)) {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break(())
        }
    }
    fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<()> {
        if !query.locks.is_empty() {
            return ControlFlow::Break(());
        }
        if body_allowed(&query.body) {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break(())
        }
    }
    fn pre_visit_select(&mut self, select: &Select) -> ControlFlow<()> {
        if select.into.is_none() {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break(())
        }
    }
}

#[cfg(test)]
#[path = "../../tests/unit/read_only_policy.rs"]
mod tests;
