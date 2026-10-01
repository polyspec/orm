//! check predicate를 읽는다 (docs/dbspec.md, "Checks"): column과 literal의
//! comparison, `in`, `is null`, 괄호를 포함한 `and`/`or`. type은 `check_type`이
//! 검사한다.

use super::lexer::{Kind, Token};
use super::literal::Value;
use super::model::{Expr, Literal, Name, Operand, Pos};

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
            Some(t) => Err(not_allowed(t)),
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
            left = Expr::Logic(Box::new(left), "or", Box::new(right));
        }
        Ok(left)
    }

    fn and(&mut self) -> Result<Expr, CheckError> {
        let mut left = self.predicate()?;
        while self.peek_is("and") {
            self.at += 1;
            let right = self.predicate()?;
            left = Expr::Logic(Box::new(left), "and", Box::new(right));
        }
        Ok(left)
    }

    /// 괄호로 묶인 predicate 또는 operand로 시작하는 predicate form. 괄호는 node를
    /// 남기지 않으며, emission이 precedence에 필요한 괄호만 쓴다.
    fn predicate(&mut self) -> Result<Expr, CheckError> {
        if self.peek_is("(") {
            self.at += 1;
            let inner = self.expression()?;
            self.expect(")")?;
            return Ok(inner);
        }
        let left = self.operand()?;
        if let Some(token) = self.peek() {
            if let Some(op) = COMPARISONS.iter().find(|op| token.is(op)) {
                self.at += 1;
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
        if self.peek_is("is") {
            self.at += 1;
            let negated = self.peek_is("not");
            if negated {
                self.at += 1;
            }
            self.expect("null")?;
            return Ok(Expr::IsNull(column, negated));
        }
        let negated = self.peek_is("not") && self.tokens.get(self.at + 1).is_some_and(|t| t.is("in"));
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
            return Ok(Expr::In(column, negated, list));
        }
        self.alone(column.pos, format!("column '{}' alone is not a predicate", column.text))
    }

    /// comparison이 뒤따르지 않는 literal의 error: `in` 또는 `is`의 subject인
    /// literal은 literal 자신에서 보고하고, 그 밖에는 operand 단독으로 처리한다.
    fn after_literal<T>(&self, literal: &Literal) -> Result<T, CheckError> {
        let subject = self.peek_is("in") || self.peek_is("is") || (self.peek_is("not") && self.tokens.get(self.at + 1).is_some_and(|t| t.is("in")));
        if subject {
            return Err((literal.pos, "a literal is not the subject of 'in' or 'is'; the subject is a column".into()));
        }
        self.alone(literal.pos, "a literal alone is not a predicate".into())
    }

    /// comparison, `in`, `is`가 뒤따르지 않는 operand의 error: 뒤에 `and`, `or`,
    /// `)` 또는 끝이 오면 operand에서, 그 밖에는 다음 token에서 보고한다.
    fn alone<T>(&self, operand: Pos, message: String) -> Result<T, CheckError> {
        match self.peek() {
            Some(t) if !(t.is("and") || t.is("or") || t.is(")")) => self.unexpected(),
            _ => Err((operand, message)),
        }
    }

    /// A column or a literal.
    fn operand(&mut self) -> Result<Operand, CheckError> {
        let Some(token) = self.peek() else { return self.unexpected() };
        if token.kind == Kind::Word && !KEYWORDS.contains(&token.text) {
            if self.tokens.get(self.at + 1).is_some_and(|t| t.is("(")) {
                return Err((token.pos, format!("function '{}' is not allowed in a check expression", token.text)));
            }
            self.at += 1;
            return Ok(Operand::Column(Name { text: token.text.to_owned(), pos: token.pos }));
        }
        self.literal().map(Operand::Literal)
    }

    /// A literal: a number with an optional unary minus, a string, `true` or `false`.
    fn literal(&mut self) -> Result<Literal, CheckError> {
        let Some(token) = self.peek() else { return self.unexpected() };
        let pos = token.pos;
        let value = if token.is("-") {
            match self.tokens.get(self.at + 1) {
                Some(next) if next.kind == Kind::Number => {
                    self.at += 1;
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
        self.at += 1;
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
