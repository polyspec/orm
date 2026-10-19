//! The tokens of a text for syntax analysis (docs/spec/dbspec.md, "Syntax analysis").

use super::lexer::{tokenize, Kind};
use super::parser::{Class, Marks};
use super::Token;
use std::collections::HashMap;

/// The tokens of `text` (docs/spec/dbspec.md, "Syntax analysis"): the lexical class of each token, and the class the parser
/// read for a word where the marks give one and the line is not lexical only.
pub(super) fn tokens(text: &str, marks: &Marks) -> Vec<Token> {
    if marks.no_tokens {
        return Vec::new();
    }
    let classes: HashMap<(usize, usize), Class> = marks.classes.iter().map(|(pos, class)| ((pos.line, pos.column), *class)).collect();
    let pieces: Vec<&str> = text.split('\n').collect();
    let last = pieces.len() - 1;
    let mut out = Vec::new();
    for (index, raw) in pieces.iter().enumerate() {
        let number = index + 1;
        // A CR before an LF is the line end (R22); a CR at the end of the text is a bare CR.
        let line = if index < last { raw.strip_suffix('\r').unwrap_or(raw) } else { raw };
        let lexical = marks.lexical_from.is_some_and(|from| number >= from);
        let trimmed = line.trim_start_matches(' ');
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('#') {
            let start = line.chars().count() - trimmed.chars().count();
            out.push(Token { line: number, start, end: start + trimmed.chars().count(), class: "comment".to_owned() });
            continue;
        }
        for token in tokenize(line, number) {
            let class = match token.kind {
                Kind::Invalid => continue,
                Kind::Word | Kind::Number => {
                    let parsed = if lexical { None } else { classes.get(&(number, token.pos.column)) };
                    match (parsed, token.kind) {
                        (Some(class), _) => class_name(*class),
                        (None, Kind::Word) => "word",
                        (None, _) => "number",
                    }
                }
                Kind::Str => "string",
                Kind::Punct if matches!(token.text, "{" | "}" | "(" | ")" | ",") => "punctuation",
                Kind::Punct => "operator",
            };
            let start = token.pos.column - 1;
            out.push(Token { line: number, start, end: start + token.text.chars().count(), class: class.to_owned() });
        }
    }
    out
}

fn class_name(class: Class) -> &'static str {
    match class {
        Class::Keyword => "keyword",
        Class::Type => "type",
        Class::Name => "name",
        Class::Setting => "setting",
        Class::Word => "word",
    }
}
