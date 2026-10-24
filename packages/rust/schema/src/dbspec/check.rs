//! Reads check predicates (docs/spec/dbspec.md, "Checks"): a column and literal
//! comparison, `in`, `is null`, and `and`/`or` with parentheses. `check_type`
//! checks the type.

use super::lexer::{Cursor, Kind, Token};
use super::literal::Value;
use super::model::{Expr, Literal, Name, Operand, Pos};

pub(crate) const KEYWORDS: [&str; 9] = ["and", "or", "not", "in", "between", "is", "null", "true", "false"];
const COMPARISONS: [&str; 6] = ["=", "<>", "<", "<=", ">", ">="];

pub(crate) struct CheckParser<'t, 'a> {
    cursor: Cursor<'t, 'a>,
}

pub(crate) type CheckError = (Pos, String);

impl<'t, 'a> CheckParser<'t, 'a> {
    /// `end` is the position reported when the expression ends early.
    pub fn new(tokens: &'t [Token<'a>], end: Pos) -> Self {
        Self { cursor: Cursor::with_end(tokens, end) }
    }

    /// The index of the first token after the parsed expression.
    pub fn position(&self) -> usize {
        self.cursor.at
    }

    fn unexpected<T>(&self) -> Result<T, CheckError> {
        match self.cursor.peek() {
            Some(t) => Err(not_allowed(t)),
            None => Err((self.cursor.here(), "check expression ends early".into())),
        }
    }

    fn expect(&mut self, text: &str) -> Result<(), CheckError> {
        if self.cursor.peek_is(text) {
            self.cursor.advance();
            Ok(())
        } else {
            self.unexpected()
        }
    }

    pub fn expression(&mut self) -> Result<Expr, CheckError> {
        let mut left = self.and()?;
        while self.cursor.peek_is("or") {
            self.cursor.advance();
            let right = self.and()?;
            left = Expr::Logic(Box::new(left), "or", Box::new(right));
        }
        Ok(left)
    }

    fn and(&mut self) -> Result<Expr, CheckError> {
        let mut left = self.predicate()?;
        while self.cursor.peek_is("and") {
            self.cursor.advance();
            let right = self.predicate()?;
            left = Expr::Logic(Box::new(left), "and", Box::new(right));
        }
        Ok(left)
    }

    /// A predicate form that starts with a parenthesized predicate or operand. Parentheses leave no node
    /// and emission writes only the parentheses that precedence requires.
    fn predicate(&mut self) -> Result<Expr, CheckError> {
        if self.cursor.peek_is("(") {
            self.cursor.advance();
            let inner = self.expression()?;
            self.expect(")")?;
            return Ok(inner);
        }
        let left = self.operand()?;
        if let Some(token) = self.cursor.peek() {
            if let Some(op) = COMPARISONS.iter().find(|op| token.is(op)) {
                self.cursor.advance();
                let right = self.operand()?;
                if let (Operand::Literal(first), Operand::Literal(_)) = (&left, &right) {
                    return Err((first.pos, "a comparison of two literals has no column".into()));
                }
                return Ok(Expr::Compare(left, op, token.pos, right));
            }
        }
        let column = match left {
            Operand::Column(column) => column,
            Operand::Literal(literal) => return self.after_literal(&literal),
        };
        if self.cursor.peek_is("is") {
            self.cursor.advance();
            let negated = self.cursor.peek_is("not");
            if negated {
                self.cursor.advance();
            }
            self.expect("null")?;
            return Ok(Expr::IsNull(column, negated));
        }
        let negated = self.cursor.peek_is("not") && self.cursor.peek_n(1).is_some_and(|t| t.is("in"));
        if negated {
            self.cursor.advance();
        }
        if self.cursor.peek_is("in") {
            self.cursor.advance();
            self.expect("(")?;
            let mut list = vec![self.literal()?];
            while self.cursor.peek_is(",") {
                self.cursor.advance();
                list.push(self.literal()?);
            }
            self.expect(")")?;
            return Ok(Expr::In(column, negated, list));
        }
        self.alone(column.pos, format!("column '{}' alone is not a predicate", column.text))
    }

    /// Error for a literal not followed by a comparison: a literal that is the subject of `in` or `is`
    /// is reported at the literal itself; otherwise it is handled as a standalone operand.
    fn after_literal<T>(&self, literal: &Literal) -> Result<T, CheckError> {
        let subject =
            self.cursor.peek_is("in") || self.cursor.peek_is("is") || (self.cursor.peek_is("not") && self.cursor.peek_n(1).is_some_and(|t| t.is("in")));
        if subject {
            return Err((literal.pos, "a literal is not the subject of 'in' or 'is'; the subject is a column".into()));
        }
        self.alone(literal.pos, "a literal alone is not a predicate".into())
    }

    /// Error for an operand not followed by a comparison, `in`, or `is`: when `and`, `or`,
    /// `)`, or the end follows, it is reported at the operand; otherwise at the next token.
    fn alone<T>(&self, operand: Pos, message: String) -> Result<T, CheckError> {
        match self.cursor.peek() {
            Some(t) if !(t.is("and") || t.is("or") || t.is(")")) => self.unexpected(),
            _ => Err((operand, message)),
        }
    }

    /// A column or a literal.
    fn operand(&mut self) -> Result<Operand, CheckError> {
        let Some(token) = self.cursor.peek() else { return self.unexpected() };
        if token.kind == Kind::Word && !KEYWORDS.contains(&token.text) {
            if self.cursor.peek_n(1).is_some_and(|t| t.is("(")) {
                return Err((token.pos, format!("function '{}' is not allowed in a check expression", token.text)));
            }
            self.cursor.advance();
            return Ok(Operand::Column(Name { text: token.text.to_owned(), pos: token.pos }));
        }
        self.literal().map(Operand::Literal)
    }

    /// A literal: a number with an optional unary minus, a string, `true` or `false`.
    fn literal(&mut self) -> Result<Literal, CheckError> {
        let Some(token) = self.cursor.peek() else { return self.unexpected() };
        let pos = token.pos;
        let value = if token.is("-") {
            match self.cursor.peek_n(1) {
                Some(next) if next.kind == Kind::Number => {
                    self.cursor.advance();
                    Value::Number { negative: true, text: next.text.to_owned() }
                }
                _ => return Err((pos, "a unary minus applies only to a number literal".into())),
            }
        } else {
            match token.kind {
                Kind::Number => Value::Number { negative: false, text: token.text.to_owned() },
                Kind::Str => Value::Str(token.string_value()),
                Kind::Word if token.is("null") => return Err((pos, "the null literal is not allowed in a check expression".into())),
                Kind::Word if token.is("true") || token.is("false") => Value::Word(token.text.to_owned()),
                _ => return self.unexpected(),
            }
        };
        self.cursor.advance();
        Ok(Literal { value, pos, text: String::new() })
    }
}

/// The error of a token outside the predicate forms.
pub(crate) fn not_allowed(token: &Token) -> CheckError {
    if ["+", "-", "*", "/"].iter().any(|op| token.is(op)) {
        (token.pos, format!("arithmetic operator '{}' is not allowed in a check expression", token.text))
    } else {
        (token.pos, format!("'{}' is not allowed in a check expression", token.text))
    }
}

#[cfg(test)]
mod tests {
    use super::CheckParser;
    use crate::dbspec::lexer::tokenize;
    use crate::dbspec::model::Pos;

    #[test]
    fn check_parser_uses_shared_cursor_for_lookahead_and_end_position() {
        let tokens = tokenize("field not in (1, 2)", 7);
        let mut parser = CheckParser::new(&tokens, Pos { line: 7, column: 21 });
        assert!(parser.expression().is_ok());
        assert_eq!(parser.position(), tokens.len());

        let empty = tokenize("", 7);
        let end = Pos { line: 7, column: 42 };
        let mut parser = CheckParser::new(&empty, end);
        assert_eq!(parser.expression().unwrap_err().0, end);
    }
}
