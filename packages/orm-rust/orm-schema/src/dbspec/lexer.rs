//! Splits one dbspec line into tokens with their 1-based character columns.

use super::model::Pos;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// A run of letters, digits, `_` and non-ASCII characters that is not a number.
    Word,
    /// Digits with an optional `.digits` fraction.
    Number,
    /// A single-quoted string; `text` keeps the quotes and doubled quotes.
    Str,
    /// One of `{ } ( ) , = <> < <= > >= + - * /`.
    Punct,
    /// A character, or an unterminated string, that no token allows.
    Invalid,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Token<'a> {
    pub kind: Kind,
    pub text: &'a str,
    pub pos: Pos,
}

impl<'a> Token<'a> {
    pub fn is(&self, text: &str) -> bool {
        matches!(self.kind, Kind::Word | Kind::Punct) && self.text == text
    }

    /// The column just after the token.
    pub fn end(&self) -> Pos {
        Pos { line: self.pos.line, column: self.pos.column + self.text.chars().count() }
    }

    /// The value of a string token without its quotes, with `''` read as one quote.
    pub fn string_value(&self) -> String {
        self.text[1..self.text.len() - 1].replace("''", "'")
    }
}

/// Whether `c` continues a word. A `.` is a word character as in Go's isWordRune, so `a.b` is one token.
fn word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.' || (!c.is_ascii() && !c.is_whitespace())
}

/// Whether `run` is digits with an optional `.digits` fraction, the form of a Number token.
fn is_number(run: &str) -> bool {
    let mut parts = run.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next();
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    digits(whole) && parts.next().is_none() && fraction.map_or(true, digits)
}

/// Tokenizes `line` (without its line end). Only the space separates tokens.
pub(crate) fn tokenize(line: &str, number: usize) -> Vec<Token<'_>> {
    let bytes = line.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    let mut column = 1;
    while i < bytes.len() {
        let c = line[i..].chars().next().unwrap_or(' ');
        if c == ' ' {
            i += 1;
            column += 1;
            continue;
        }
        let start = i;
        let kind;
        if word_char(c) {
            let mut j = i;
            while j < bytes.len() {
                let d = line[j..].chars().next().unwrap_or(' ');
                if !word_char(d) {
                    break;
                }
                j += d.len_utf8();
            }
            kind = if is_number(&line[i..j]) { Kind::Number } else { Kind::Word };
            i = j;
        } else if c == '\'' {
            let mut j = i + 1;
            let mut closed = false;
            while j < bytes.len() {
                if bytes[j] == b'\'' {
                    if j + 1 < bytes.len() && bytes[j + 1] == b'\'' {
                        j += 2;
                        continue;
                    }
                    closed = true;
                    j += 1;
                    break;
                }
                j += 1;
            }
            kind = if closed { Kind::Str } else { Kind::Invalid };
            i = j;
        } else {
            let two = if i + 1 < bytes.len() { &line[i..i + 2] } else { "" };
            if matches!(two, "<>" | "<=" | ">=") {
                kind = Kind::Punct;
                i += 2;
            } else if matches!(c, '{' | '}' | '(' | ')' | ',' | '=' | '<' | '>' | '+' | '-' | '*' | '/') {
                kind = Kind::Punct;
                i += 1;
            } else {
                kind = Kind::Invalid;
                i += c.len_utf8();
            }
        }
        let text = &line[start..i];
        tokens.push(Token { kind, text, pos: Pos { line: number, column } });
        column += text.chars().count();
    }
    tokens
}
