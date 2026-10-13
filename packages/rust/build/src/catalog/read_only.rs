use sqlparser::{
    ast::{Expr, Query, Select, SetExpr, Statement, Visit, Visitor},
    dialect::{Dialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect},
    parser::Parser,
    tokenizer::{Token, Tokenizer, Whitespace},
};
use std::ops::ControlFlow;

pub(super) fn validate(sql: &str, dialect: &str) -> Result<(), String> {
    if sql.is_empty() || sql.len() > 256 * 1024 {
        return Err(error());
    }
    let dialect: Box<dyn Dialect> = match dialect {
        "mysql" => Box::new(MySqlDialect {}),
        "postgres" => Box::new(PostgreSqlDialect {}),
        "sqlite" => Box::new(SQLiteDialect {}),
        _ => return Err(error()),
    };
    let tokens = Tokenizer::new(dialect.as_ref(), sql).tokenize().map_err(|_| error())?;
    if tokens
        .iter()
        .any(|token| matches!(token,Token::Whitespace(Whitespace::MultiLineComment(comment)) if comment.starts_with('!')||comment.starts_with("M!")))
    {
        return Err(error());
    }
    let statements = Parser::new(dialect.as_ref()).with_recursion_limit(64).with_tokens(tokens).parse_statements().map_err(|_| error())?;
    if statements.len() != 1 || !matches!(statements[0], Statement::Query(_)) || statements.visit(&mut ReadOnly { expression_depth: 0 }).is_break() {
        return Err(error());
    }
    Ok(())
}
fn error() -> String {
    "QUERY_READ_ONLY: expected one supported non-locking read query".into()
}
struct ReadOnly {
    expression_depth: usize,
}
fn body_allowed(body: &SetExpr) -> bool {
    let mut pending = vec![(body, 0)];
    while let Some((body, depth)) = pending.pop() {
        if depth >= 64 {
            return false;
        }
        match body {
            SetExpr::Select(_) | SetExpr::Values(_) | SetExpr::Query(_) => {}
            SetExpr::SetOperation { left, right, .. } => {
                pending.push((left, depth + 1));
                pending.push((right, depth + 1));
            }
            _ => return false,
        }
    }
    true
}
impl Visitor for ReadOnly {
    type Break = ();
    fn pre_visit_expr(&mut self, _: &Expr) -> ControlFlow<()> {
        self.expression_depth += 1;
        if self.expression_depth > 64 {
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
        if query.locks.is_empty() && body_allowed(&query.body) {
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
