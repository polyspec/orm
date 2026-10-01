//! The neutral check expression: column references, literals, comparisons,
//! arithmetic, `and`/`or`/`not`, `in`, `between` and `is null`.

use super::lexer::{Kind, Token};
use super::literal::{canonical_check_decimal, canonical_integer, quote};
use super::model::{Expr, Name, Pos};

const KEYWORDS: [&str; 9] = ["and", "or", "not", "in", "between", "is", "null", "true", "false"];
const COMPARISONS: [&str; 6] = ["=", "<>", "<", "<=", ">", ">="];

pub(crate) struct CheckParser<'t, 'a> {
    tokens: &'t [Token<'a>],
    at: usize,
    end: Pos,
}

pub(crate) type CheckError = (Pos, String);

impl<'t, 'a> CheckParser<'t, 'a> {
    /// `end` is the position reported when the expression ends early.
    pub fn new(tokens: &'t [Token<'a>], end: Pos) -> Self {
        Self { tokens, at: 0, end }
    }

    /// The index of the first token after the parsed expression.
    pub fn position(&self) -> usize {
        self.at
    }

    fn peek(&self) -> Option<&'t Token<'a>> {
        self.tokens.get(self.at)
    }

    fn peek_is(&self, text: &str) -> bool {
        self.peek().is_some_and(|t| t.is(text))
    }

    fn unexpected<T>(&self) -> Result<T, CheckError> {
        match self.peek() {
            Some(t) => Err((t.pos, format!("'{}' is not allowed in a check expression", t.text))),
            None => Err((self.end, "check expression ends early".into())),
        }
    }

    fn expect(&mut self, text: &str) -> Result<(), CheckError> {
        if self.peek_is(text) {
            self.at += 1;
            Ok(())
        } else {
            self.unexpected()
        }
    }

    pub fn expression(&mut self) -> Result<Expr, CheckError> {
        let mut left = self.and()?;
        while self.peek_is("or") {
            self.at += 1;
            let right = self.and()?;
            left = Expr::Binary(Box::new(left), "or", Box::new(right));
        }
        Ok(left)
    }

    fn and(&mut self) -> Result<Expr, CheckError> {
        let mut left = self.not()?;
        while self.peek_is("and") {
            self.at += 1;
            let right = self.not()?;
            left = Expr::Binary(Box::new(left), "and", Box::new(right));
        }
        Ok(left)
    }

    fn not(&mut self) -> Result<Expr, CheckError> {
        if self.peek_is("not") {
            self.at += 1;
            return Ok(Expr::Not(Box::new(self.not()?)));
        }
        self.predicate()
    }

    fn predicate(&mut self) -> Result<Expr, CheckError> {
        let left = self.additive()?;
        if let Some(op) = self.peek().and_then(|t| COMPARISONS.iter().find(|op| t.is(op))) {
            self.at += 1;
            let right = self.additive()?;
            return Ok(Expr::Binary(Box::new(left), op, Box::new(right)));
        }
        if self.peek_is("is") {
            self.at += 1;
            let negated = self.peek_is("not");
            if negated {
                self.at += 1;
            }
            self.expect("null")?;
            return Ok(Expr::IsNull(Box::new(left), negated));
        }
        let negated = self.peek_is("not") && self.tokens.get(self.at + 1).is_some_and(|t| t.is("in") || t.is("between"));
        if negated {
            self.at += 1;
        }
        if self.peek_is("in") {
            self.at += 1;
            self.expect("(")?;
            let mut list = vec![self.literal()?];
            while self.peek_is(",") {
                self.at += 1;
                list.push(self.literal()?);
            }
            self.expect(")")?;
            return Ok(Expr::In(Box::new(left), negated, list));
        }
        if self.peek_is("between") {
            self.at += 1;
            let low = self.additive()?;
            self.expect("and")?;
            let high = self.additive()?;
            return Ok(Expr::Between(Box::new(left), negated, Box::new(low), Box::new(high)));
        }
        Ok(left)
    }

    fn additive(&mut self) -> Result<Expr, CheckError> {
        let mut left = self.multiplicative()?;
        while let Some(op) = self.peek().and_then(|t| ["+", "-"].into_iter().find(|op| t.is(op))) {
            self.at += 1;
            let right = self.multiplicative()?;
            left = Expr::Binary(Box::new(left), op, Box::new(right));
        }
        Ok(left)
    }

    fn multiplicative(&mut self) -> Result<Expr, CheckError> {
        let mut left = self.primary()?;
        while let Some(op) = self.peek().and_then(|t| ["*", "/"].into_iter().find(|op| t.is(op))) {
            self.at += 1;
            let right = self.primary()?;
            left = Expr::Binary(Box::new(left), op, Box::new(right));
        }
        Ok(left)
    }

    /// A literal: a signed integer or decimal, a string, `true`, `false` or `null`.
    fn literal(&mut self) -> Result<String, CheckError> {
        let Some(token) = self.peek() else { return self.unexpected() };
        let negative = token.is("-");
        let token = if negative {
            match self.tokens.get(self.at + 1) {
                Some(next) if next.kind == Kind::Number => {
                    self.at += 1;
                    next
                }
                _ => return self.unexpected(),
            }
        } else {
            token
        };
        let text = match token.kind {
            Kind::Number if token.text.contains('.') => canonical_check_decimal(negative, token.text),
            Kind::Number => canonical_integer(negative, token.text),
            Kind::Str => quote(&token.string_value()),
            Kind::Word if matches!(token.text, "true" | "false" | "null") => token.text.to_owned(),
            _ => return self.unexpected(),
        };
        self.at += 1;
        Ok(text)
    }

    fn primary(&mut self) -> Result<Expr, CheckError> {
        let Some(token) = self.peek() else { return self.unexpected() };
        if token.is("(") {
            self.at += 1;
            let inner = self.expression()?;
            self.expect(")")?;
            return Ok(Expr::Paren(Box::new(inner)));
        }
        if token.kind == Kind::Word && !KEYWORDS.contains(&token.text) {
            if self.tokens.get(self.at + 1).is_some_and(|t| t.is("(")) {
                return Err((token.pos, format!("function '{}' is not allowed in a check expression", token.text)));
            }
            self.at += 1;
            return Ok(Expr::Column(Name { text: token.text.to_owned(), pos: token.pos }));
        }
        self.literal().map(Expr::Literal)
    }
}
