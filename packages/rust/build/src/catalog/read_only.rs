use sqlparser::{
    ast::{Expr, Query, Select, SetExpr, Statement, Visit, Visitor},
    dialect::{Dialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect},
    parser::Parser,
    tokenizer::{Token, Tokenizer, Whitespace},
};
use std::ops::ControlFlow;

#[derive(Debug)]
pub(super) struct ReadOnlyError {
    cause: Option<Box<dyn std::error::Error + Send + Sync>>,
    /// A PostgreSQL read over the operand or term bound, which is a budget refusal and not a write (INT-136).
    limit: bool,
}

impl std::fmt::Display for ReadOnlyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.limit {
            return formatter.write_str("CATALOG_LIMIT: a PostgreSQL read has 200 or more UNION ALL operands or + terms");
        }
        formatter.write_str("QUERY_READ_ONLY: expected one supported non-locking read query")
    }
}

impl std::error::Error for ReadOnlyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause.as_deref().map(|cause| cause as &(dyn std::error::Error + 'static))
    }
}

pub(super) fn validate(sql: &str, dialect: &str) -> Result<(), ReadOnlyError> {
    if sql.is_empty() || sql.len() > 256 * 1024 {
        return Err(error());
    }
    let postgres = dialect == "postgres";
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
    let mut visitor = ReadOnly { expression_depth: 0, postgres, limit: false };
    if statements.len() != 1 || !matches!(statements[0], Statement::Query(_)) || statements.visit(&mut visitor).is_break() {
        return Err(if visitor.limit { limit() } else { error() });
    }
    Ok(())
}
fn error() -> ReadOnlyError {
    ReadOnlyError { cause: None, limit: false }
}

fn limit() -> ReadOnlyError {
    ReadOnlyError { cause: None, limit: true }
}

fn error_with(error: impl std::error::Error + Send + Sync + 'static) -> ReadOnlyError {
    ReadOnlyError { cause: Some(Box::new(error)), limit: false }
}

/// The operands of a PostgreSQL read, a UNION ALL operand or a + term, at which the read is refused with CATALOG_LIMIT (INT-136).
const POSTGRES_OPERANDS: usize = 200;

struct ReadOnly {
    expression_depth: usize,
    postgres: bool,
    /// Set when the read is refused for its PostgreSQL operand or term bound, not for a write.
    limit: bool,
}

/// What the set operations of a query body allow: the body is read, refused, or over the PostgreSQL operand bound.
enum Walk {
    Allowed,
    Refused,
    Limit,
}

fn body_allowed(body: &SetExpr, postgres: bool) -> Walk {
    let mut pending = vec![(body, 0)];
    let mut operands = 0usize;
    while let Some((body, depth)) = pending.pop() {
        if !postgres && depth >= 64 {
            return Walk::Refused;
        }
        match body {
            SetExpr::Select(_) | SetExpr::Values(_) | SetExpr::Query(_) => operands += 1,
            SetExpr::SetOperation { left, right, .. } => {
                pending.push((left, depth + 1));
                pending.push((right, depth + 1));
            }
            _ => return Walk::Refused,
        }
    }
    if postgres && operands >= POSTGRES_OPERANDS {
        Walk::Limit
    } else {
        Walk::Allowed
    }
}
impl Visitor for ReadOnly {
    type Break = ();
    fn pre_visit_expr(&mut self, _: &Expr) -> ControlFlow<()> {
        self.expression_depth += 1;
        if self.postgres && self.expression_depth >= POSTGRES_OPERANDS {
            self.limit = true;
            ControlFlow::Break(())
        } else if !self.postgres && self.expression_depth > 64 {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    }
    fn post_visit_expr(&mut self, _: &Expr) -> ControlFlow<()> {
        self.expression_depth -= 1;
        ControlFlow::Continue(())
    }
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
        match body_allowed(&query.body, self.postgres) {
            Walk::Allowed => ControlFlow::Continue(()),
            Walk::Refused => ControlFlow::Break(()),
            Walk::Limit => {
                self.limit = true;
                ControlFlow::Break(())
            }
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
