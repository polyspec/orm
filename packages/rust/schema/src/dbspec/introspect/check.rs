//! dialect catalog의 check 식을 dbspec predicate text로 읽는다
//! (docs/dialects.md "Introspection", "Checks").

use super::super::literal::quote;
use super::super::model::Type;
use super::super::render::Dialect;
use std::collections::BTreeMap;

/// check 식 `text`를 dbspec predicate로 읽는다. `columns`는 table의 column
/// type이며, literal은 그것이 만나는 column의 값으로 읽는다. 읽을 수 없는 식은
/// error다.
pub(super) fn decode_check(dialect: Dialect, text: &str, columns: &BTreeMap<String, Type>) -> Result<String, String> {
    let unescaped;
    let mut text = text;
    if dialect == Dialect::MySql {
        unescaped = unescape_mysql_clause(text);
        text = &unescaped;
    }
    if dialect == Dialect::Postgres {
        text = text.strip_prefix("CHECK ").ok_or_else(|| format!("constraint definition {text:?} does not start with CHECK"))?;
    }
    let tokens = tokens(dialect, text)?;
    let mut d = Decoder { tokens, i: 0, columns, dialect };
    let node = d.expression()?;
    if d.i != d.tokens.len() {
        return Err(format!("unexpected {:?}", d.tokens[d.i].text));
    }
    match node {
        Node::Predicate(p) => d.write(&p),
        Node::Operand(_) => Err("an operand alone is not a predicate".to_owned()),
    }
}

/// CHECK_CLAUSE가 문자열 literal에 더한 두 번째 escape를 푼다: `\\`는 `\`,
/// `\'`는 `'`가 된다.
fn unescape_mysql_clause(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(&next @ ('\\' | '\'')) = chars.peek() {
                out.push(next);
                chars.next();
                continue;
            }
        }
        out.push(ch);
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TokenKind {
    Ident,
    Word,
    Number,
    Str,
    Op,
    Punct,
}

#[derive(Clone, Debug)]
struct Token {
    kind: TokenKind,
    text: String,
}

fn token(kind: TokenKind, text: &str) -> Token {
    Token { kind, text: text.to_owned() }
}

fn is_word_start(ch: u8) -> bool {
    ch == b'_' || ch.is_ascii_alphabetic()
}

fn tokens(dialect: Dialect, text: &str) -> Result<Vec<Token>, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let ch = bytes[i];
        let rest = &text[i..];
        if ch == b' ' {
            i += 1;
        } else if ch == b'`' || ch == b'"' {
            let end = text[i + 1..].find(ch as char).ok_or("unclosed identifier")?;
            out.push(token(TokenKind::Ident, &text[i + 1..i + 1 + end]));
            i += end + 2;
        } else if ch == b'\'' {
            let (value, n) = read_sql_string(dialect, rest)?;
            out.push(Token { kind: TokenKind::Str, text: value });
            i += n;
        } else if ch.is_ascii_digit() {
            let mut j = i;
            while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b'.') {
                j += 1;
            }
            out.push(token(TokenKind::Number, &text[i..j]));
            i = j;
        } else if is_word_start(ch) {
            let mut j = i;
            while j < bytes.len() && (is_word_start(bytes[j]) || bytes[j].is_ascii_digit()) {
                j += 1;
            }
            let word = &text[i..j];
            // MySQL 문자열 앞의 character set introducer는 값이 아니다.
            if dialect == Dialect::MySql && word.starts_with('_') && j < bytes.len() && bytes[j] == b'\'' {
                i = j;
                continue;
            }
            out.push(token(TokenKind::Word, word));
            i = j;
        } else if rest.starts_with("::") {
            out.push(token(TokenKind::Op, "::"));
            i += 2;
        } else if rest.starts_with("<>") || rest.starts_with("<=") || rest.starts_with(">=") {
            out.push(token(TokenKind::Op, &rest[..2]));
            i += 2;
        } else if matches!(ch, b'=' | b'<' | b'>' | b'-') {
            out.push(token(TokenKind::Op, &rest[..1]));
            i += 1;
        } else if matches!(ch, b'(' | b')' | b',' | b'[' | b']') {
            out.push(token(TokenKind::Punct, &rest[..1]));
            i += 1;
        } else {
            let unexpected = rest.chars().next().unwrap_or_default();
            return Err(format!("unexpected character {unexpected:?}"));
        }
    }
    Ok(out)
}

/// text 앞의 문자열 literal을 읽어 값과 byte 길이를 돌려준다. PostgreSQL과
/// SQLite는 `''`만 escape이고, MySQL은 backslash escape도 쓴다.
fn read_sql_string(dialect: Dialect, text: &str) -> Result<(String, usize), String> {
    let mut out = String::new();
    let mut chars = text.char_indices().skip(1).peekable();
    while let Some((i, ch)) = chars.next() {
        match ch {
            '\'' if chars.peek().is_some_and(|(_, next)| *next == '\'') => {
                out.push('\'');
                chars.next();
            }
            '\'' => return Ok((out, i + 1)),
            '\\' if dialect == Dialect::MySql && chars.peek().is_some() => {
                let (_, escaped) = chars.next().expect("peeked");
                out.push(match escaped {
                    '0' => '\0',
                    'b' => '\u{8}',
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    'Z' => '\u{1a}',
                    other => other,
                });
            }
            _ => out.push(ch),
        }
    }
    Err("unclosed string literal".to_owned())
}

/// column이나 literal. kind는 column, number, string, bool이다.
#[derive(Clone, Debug)]
struct Operand {
    kind: &'static str,
    text: String,
}

/// 비교, in, is null, and, or.
#[derive(Clone, Debug)]
enum Predicate {
    Logic(&'static str, Box<Node>, Box<Node>),
    Compare(Operand, String, Operand),
    In(Operand, Vec<Operand>, bool),
    Null(Operand, bool),
}

#[derive(Clone, Debug)]
enum Node {
    Operand(Operand),
    Predicate(Predicate),
}

struct Decoder<'c> {
    tokens: Vec<Token>,
    i: usize,
    columns: &'c BTreeMap<String, Type>,
    dialect: Dialect,
}

impl Decoder<'_> {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.i)
    }

    fn peek_is(&self, kind: TokenKind, text: &str) -> bool {
        self.peek().is_some_and(|t| t.kind == kind && t.text == text)
    }

    fn word(&mut self, text: &str) -> bool {
        if self.peek().is_some_and(|t| t.kind == TokenKind::Word && t.text.eq_ignore_ascii_case(text)) {
            self.i += 1;
            return true;
        }
        false
    }

    fn punct(&mut self, text: &str) -> bool {
        if self.peek_is(TokenKind::Punct, text) {
            self.i += 1;
            return true;
        }
        false
    }

    fn expect(&mut self, text: &str) -> Result<(), String> {
        if self.punct(text) {
            Ok(())
        } else {
            Err(format!("expected {text:?} at token {}", self.i))
        }
    }

    fn expression(&mut self) -> Result<Node, String> {
        let mut left = self.and()?;
        while self.word("or") {
            let right = self.and()?;
            left = Node::Predicate(Predicate::Logic("or", Box::new(left), Box::new(right)));
        }
        Ok(left)
    }

    fn and(&mut self) -> Result<Node, String> {
        let mut left = self.predicate()?;
        while self.word("and") {
            let right = self.predicate()?;
            left = Node::Predicate(Predicate::Logic("and", Box::new(left), Box::new(right)));
        }
        Ok(left)
    }

    /// 괄호로 묶인 식이나 operand로 시작하는 predicate 하나를 읽는다.
    fn predicate(&mut self) -> Result<Node, String> {
        let operand = match self.term()? {
            Node::Operand(operand) => operand,
            predicate => return Ok(predicate),
        };
        if let Some(op) =
            self.peek().filter(|t| t.kind == TokenKind::Op && ["=", "<>", "<", "<=", ">", ">="].contains(&t.text.as_str())).map(|t| t.text.clone())
        {
            self.i += 1;
            if self.word("any") || self.word("all") {
                let list = self.array()?;
                return match op.as_str() {
                    "=" => Ok(Node::Predicate(Predicate::In(operand, list, false))),
                    "<>" => Ok(Node::Predicate(Predicate::In(operand, list, true))),
                    _ => Err(format!("{op} with ANY or ALL")),
                };
            }
            return match self.term()? {
                Node::Operand(right) => Ok(Node::Predicate(Predicate::Compare(operand, op, right))),
                Node::Predicate(_) => Err("a comparison with a predicate".to_owned()),
            };
        }
        if self.word("is") {
            let negated = self.word("not");
            if !self.word("null") {
                return Err("expected null after is".to_owned());
            }
            return Ok(Node::Predicate(Predicate::Null(operand, negated)));
        }
        if self.word("not") {
            if !self.word("in") {
                return Err("not outside not in".to_owned());
            }
            let list = self.list()?;
            return Ok(Node::Predicate(Predicate::In(operand, list, true)));
        }
        if self.word("in") {
            let list = self.list()?;
            return Ok(Node::Predicate(Predicate::In(operand, list, false)));
        }
        Ok(Node::Operand(operand))
    }

    /// 괄호 식이나 operand와 그 뒤의 cast를 읽는다. 괄호 안이 operand 하나면
    /// operand다.
    fn term(&mut self) -> Result<Node, String> {
        let mut node = if self.punct("(") {
            let inner = self.expression()?;
            self.expect(")")?;
            inner
        } else {
            Node::Operand(self.operand()?)
        };
        while self.peek_is(TokenKind::Op, "::") {
            self.i += 1;
            let type_name = self.cast_type();
            let Node::Operand(mut operand) = node else { return Err("a cast of a predicate".to_owned()) };
            if operand.kind == "string" && numeric_cast(&type_name) {
                operand.kind = "number";
            }
            node = Node::Operand(operand);
        }
        Ok(node)
    }

    /// `::` 뒤의 type 이름을 읽는다: 단어들과 (n), [].
    fn cast_type(&mut self) -> String {
        let mut words = Vec::new();
        while let Some(t) = self.peek() {
            if t.kind == TokenKind::Word && !["and", "or", "is", "not", "in"].iter().any(|k| t.text.eq_ignore_ascii_case(k)) {
                words.push(t.text.clone());
                self.i += 1;
            } else if t.kind == TokenKind::Punct && t.text == "[" && self.tokens.get(self.i + 1).is_some_and(|n| n.text == "]") {
                self.i += 2;
            } else {
                break;
            }
        }
        words.join(" ")
    }

    fn operand(&mut self) -> Result<Operand, String> {
        let Some(t) = self.peek().cloned() else { return Err(format!("unexpected {:?}", "")) };
        let operand = |kind: &'static str, text: String| Operand { kind, text };
        match t.kind {
            TokenKind::Ident => {
                self.i += 1;
                Ok(operand("column", t.text))
            }
            TokenKind::Number => {
                self.i += 1;
                Ok(operand("number", t.text))
            }
            TokenKind::Str => {
                self.i += 1;
                Ok(operand("string", t.text))
            }
            TokenKind::Op if t.text == "-" => {
                self.i += 1;
                let parenthesized = self.punct("(");
                let Some(n) = self.peek().filter(|n| n.kind == TokenKind::Number).cloned() else {
                    return Err(if parenthesized { "expected a number after -(" } else { "expected a number after -" }.to_owned());
                };
                self.i += 1;
                if parenthesized {
                    self.expect(")")?;
                }
                Ok(operand("number", format!("-{}", n.text)))
            }
            TokenKind::Word if t.text.eq_ignore_ascii_case("true") || t.text.eq_ignore_ascii_case("false") => {
                self.i += 1;
                Ok(operand("bool", t.text.to_lowercase()))
            }
            TokenKind::Word => {
                self.i += 1;
                Ok(operand("column", t.text))
            }
            _ => Err(format!("unexpected {:?}", t.text)),
        }
    }

    /// in 뒤의 (a, b, ...)를 읽는다.
    fn list(&mut self) -> Result<Vec<Operand>, String> {
        self.expect("(")?;
        let mut out = Vec::new();
        loop {
            match self.term()? {
                Node::Operand(o) if o.kind != "column" => out.push(o),
                _ => return Err("an in list holds literals only".to_owned()),
            }
            if self.punct(")") {
                return Ok(out);
            }
            self.expect(",")?;
        }
    }

    /// PostgreSQL의 ANY나 ALL 뒤의 (ARRAY[...]) 또는 ((ARRAY[...])::type[])를
    /// 읽는다.
    fn array(&mut self) -> Result<Vec<Operand>, String> {
        self.expect("(")?;
        let wrapped = self.punct("(");
        if !self.word("array") {
            return Err("expected ARRAY".to_owned());
        }
        self.expect("[")?;
        let mut out = Vec::new();
        loop {
            match self.term()? {
                Node::Operand(o) if o.kind != "column" => out.push(o),
                _ => return Err("an array holds literals only".to_owned()),
            }
            if self.punct("]") {
                break;
            }
            self.expect(",")?;
        }
        if wrapped {
            self.expect(")")?;
            if self.peek().is_some_and(|t| t.text == "::") {
                self.i += 1;
                self.cast_type();
            }
        }
        self.expect(")")?;
        Ok(out)
    }

    /// predicate를 dbspec text로 쓴다. 괄호는 필요한 곳보다 많아도 되며
    /// canonical form은 parse가 정한다.
    fn write(&self, p: &Predicate) -> Result<String, String> {
        match p {
            Predicate::Logic(op, left, right) => Ok(format!("({} {op} {})", self.side(left)?, self.side(right)?)),
            Predicate::Compare(left, op, right) => {
                let typ = self.type_of(left, Some(right));
                Ok(format!("{} {op} {}", self.operand_text(left, typ)?, self.operand_text(right, typ)?))
            }
            Predicate::In(left, list, negated) => {
                let typ = self.type_of(left, None);
                let items = list.iter().map(|item| self.operand_text(item, typ)).collect::<Result<Vec<_>, _>>()?;
                let keyword = if *negated { "not in" } else { "in" };
                Ok(format!("{} {keyword} ({})", self.operand_text(left, typ)?, items.join(", ")))
            }
            Predicate::Null(left, negated) => {
                let l = self.operand_text(left, None)?;
                Ok(if *negated { format!("{l} is not null") } else { format!("{l} is null") })
            }
        }
    }

    fn side(&self, n: &Node) -> Result<String, String> {
        match n {
            Node::Predicate(p) => self.write(p),
            Node::Operand(_) => Err("an operand alone is not a predicate".to_owned()),
        }
    }

    /// 첫 column operand의 type. 모르는 column이면 None이다.
    fn type_of(&self, a: &Operand, b: Option<&Operand>) -> Option<Type> {
        [Some(a), b].into_iter().flatten().find(|o| o.kind == "column").and_then(|o| self.columns.get(&o.text).copied())
    }

    /// operand를 dbspec 표기로 쓴다. bool column의 1과 0은 true와 false, SQLite
    /// decimal의 정수는 scale을 나눈 값이다.
    fn operand_text(&self, o: &Operand, typ: Option<Type>) -> Result<String, String> {
        match o.kind {
            "column" => {
                if !self.columns.contains_key(&o.text) {
                    return Err(format!("unknown column {}", o.text));
                }
                Ok(o.text.clone())
            }
            "string" => Ok(quote(&o.text)),
            "bool" => Ok(o.text.clone()),
            _ => Ok(match typ {
                Some(Type::Bool) if o.text == "1" => "true".to_owned(),
                Some(Type::Bool) if o.text == "0" => "false".to_owned(),
                Some(Type::Decimal(_, scale)) if self.dialect == Dialect::Sqlite => unscaled_decimal(&o.text, usize::from(scale)),
                _ => o.text.clone(),
            }),
        }
    }
}

fn numeric_cast(type_name: &str) -> bool {
    matches!(type_name, "smallint" | "integer" | "bigint" | "numeric" | "double precision" | "real")
}

/// 10^scale을 곱한 정수 text를 scale 자리 소수로 쓴다.
pub(super) fn unscaled_decimal(text: &str, scale: usize) -> String {
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let mut digits = digits.to_owned();
    if scale > 0 {
        if digits.len() <= scale {
            digits = "0".repeat(scale - digits.len() + 1) + &digits;
        }
        digits.insert(digits.len() - scale, '.');
    }
    if negative {
        format!("-{digits}")
    } else {
        digits
    }
}
