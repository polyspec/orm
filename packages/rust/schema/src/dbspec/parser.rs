//! Reads dbspec text line by line into the model and reports the errors that a
//! single line shows. Cross references are checked by `validate`.

use super::check::{not_allowed, CheckParser, KEYWORDS};
use super::lexer::{go_quote, tokenize, Cursor, Kind, Token};
use super::literal::{default_literal, Value};
use super::model::*;
use std::collections::HashSet;

pub(crate) const MAX_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_TABLES: usize = 4096;
pub(crate) const MAX_COLUMNS: usize = 120_000;
pub(crate) const MAX_FOREIGN_KEYS: usize = 20_000;
pub(crate) const MAX_TABLE_COLUMNS: usize = 1000;
pub(crate) const MAX_NAME_BYTES: usize = 63;

/// Words that are not valid names.
const RESERVED: [&str; 21] = [
    "dbspec", "use", "table", "diagram", "primary", "unique", "index", "foreign", "check", "settings", "null", "identity", "default", "true", "false", "and",
    "or", "not", "in", "between", "is",
];

/// A name that matches `[a-z][a-z0-9_]*`, is not reserved and has at most 63 bytes.
pub(crate) fn well_formed(text: &str) -> bool {
    name_format(text) && text.len() <= MAX_NAME_BYTES
}

/// The diagnostic of a malformed name, if any.
pub(crate) fn name_problem(text: &str) -> Option<(&'static str, String)> {
    if !name_format(text) {
        Some(("name.format", format!("name {} does not match [a-z][a-z0-9_]* or is a reserved word", go_quote(text))))
    } else if text.len() > MAX_NAME_BYTES {
        Some(("name.length", format!("name {} has {} bytes, more than {MAX_NAME_BYTES}", go_quote(text), text.len())))
    } else {
        None
    }
}

fn name_format(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty() && bytes[0].is_ascii_lowercase() && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_') && !reserved(text)
}

/// A reserved word, which is not a valid name.
pub(crate) fn reserved(text: &str) -> bool {
    RESERVED.contains(&text)
}

/// What a column name position of a setting line expects.
const COLUMN: &str = "a column name";

pub(crate) const CODEC_STAGES: [&str; 8] = ["json", "aes", "hex", "gz", "base64", "serialize", "yaml", "ip"];
/// The name of the codec stage `json` in the language implementations, which the core reads as `json` (CORE-61).
const LEGACY_JSON_STAGE: &str = "ordered_json";

#[derive(Clone, Debug)]
pub(crate) struct Diag {
    pub pos: Pos,
    pub rule: &'static str,
    pub message: String,
}

/// One declaration that the parser read into the document, recorded where its name token is in hand
/// (docs/spec/dbspec.md "Declaration positions"). `path` is the enclosing names and the own name; a setting
/// has the table alone in `path` and its keyword and identity words in `setting`.
#[derive(Clone, Debug)]
pub(crate) struct Declaration {
    pub kind: &'static str,
    pub path: Vec<String>,
    pub pos: Pos,
    pub setting: Option<SettingWords>,
}

/// The keyword of a setting line as written, and the words that its repeat identity is made of, in the
/// order of the line.
#[derive(Clone, Debug)]
pub(crate) struct SettingWords {
    pub keyword: String,
    pub args: Vec<String>,
}

/// The syntax of a document with the line errors, and for each table the names of
/// columns whose lines failed, so references to them report nothing more.
pub(crate) struct Syntax {
    pub document: Document,
    /// The words of the use lines that failed.
    pub failed_uses: Vec<String>,
    /// The declarations of the document, in the order they were read; positions sorts them.
    pub declarations: Vec<Declaration>,
    pub unresolved: Vec<Vec<String>>,
    /// For each table, the name of a column line whose type is wrong. Go keeps such a column, so a child of a foreign key that points to that column is treated as known.
    pub typeless: Vec<Vec<(String, bool)>>,
    /// For each table, the key and index lines that failed.
    pub failed_keys: Vec<FailedKeys>,
    /// For each table, whether the table line failed (it has no name, no `{`, or text after `{`). This is Go's failed table.
    pub header_failed: Vec<bool>,
    /// For each table, the `default` value tokens of its column lines that parsed.
    pub defaults: Vec<Vec<DefaultToken>>,
    pub diags: Vec<Diag>,
    pub marks: Marks,
}

/// The names of a setting that its repeat identity is made of (docs/spec/dbspec.md "Settings"): the column of
/// codec and markdown, the foreign key of navigation, and the AES column and the column of blind_index. Other
/// settings have no identity and no words.
fn setting_words(setting: &Setting) -> Vec<String> {
    let text = |name: &Name| name.text.clone();
    match setting {
        Setting::Codec(column, _) | Setting::Markdown(column) => vec![text(column)],
        Setting::Navigation(key, child, parent) => vec![text(key), text(child), text(parent)],
        Setting::BlindIndex(aes, column) => vec![text(aes), text(column)],
        _ => Vec::new(),
    }
}

/// A column `default` whose value token parsed, by its column. Validation reads it for the rule that an
/// `order` column has no default.
#[derive(Clone, Debug)]
pub(crate) struct DefaultToken {
    pub column: String,
}

/// Key and index lines of a table that failed: their columns are unknown, so
/// the rules that depend on them report nothing.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct FailedKeys {
    /// A `primary key` line failed.
    pub primary: bool,
    /// A `primary key`, `unique` or `index` line failed.
    pub any: bool,
}

/// A stopping error (`encoding`, `header` or `limit`) ends parsing with the
/// errors reported up to it.
/// The class of a token that the parser read as a word of a given position (docs/spec/dbspec.md "Syntax analysis").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Class {
    Keyword,
    Type,
    Name,
    Setting,
    /// A word that the parser read without a class (R3, R5): it stays a `word`.
    Word,
}

/// The classes of the words of a text and where they stop applying.
#[derive(Clone, Debug, Default)]
pub(crate) struct Marks {
    /// The class of each marked word, by its position; a later mark of a position replaces an earlier one.
    pub classes: Vec<(Pos, Class)>,
    /// The first line whose tokens are lexical only: the line of an encoding or header stop.
    pub lexical_from: Option<usize>,
    /// A limit stop: the text has no tokens.
    pub no_tokens: bool,
}

/// A stopped parse: its diagnostics and the classes read before the stop.
#[derive(Debug)]
pub(crate) struct Stopped {
    pub diags: Vec<Diag>,
    pub marks: Marks,
}

/// The marks of a stop: a limit stop gives no tokens; an encoding or header stop makes its line and the later
/// lines lexical.
fn stop_marks(diag: &Diag) -> Marks {
    if diag.rule == "limit" {
        Marks { no_tokens: true, ..Marks::default() }
    } else {
        Marks { lexical_from: Some(diag.pos.line), ..Marks::default() }
    }
}

fn stopping(diag: Diag) -> Stopped {
    Stopped { marks: stop_marks(&diag), diags: vec![diag] }
}

enum Context {
    Top,
    Table,
    Settings,
    Diagram,
}

struct Parser {
    diags: Vec<Diag>,
    declarations: Vec<Declaration>,
    pending: Vec<String>,
    document: Document,
    failed_uses: Vec<String>,
    unresolved: Vec<Vec<String>>,
    typeless: Vec<Vec<(String, bool)>>,
    table_typeless: Vec<(String, bool)>,
    failed_keys: Vec<FailedKeys>,
    header_failed: Vec<bool>,
    table_header_failed: bool,
    defaults: Vec<Vec<DefaultToken>>,
    table_defaults: Vec<DefaultToken>,
    context: Context,
    /// Depth of an unreadable block whose lines are skipped.
    skip: usize,
    /// Top-level phase: 0 `use`, 1 `table`, 2 `diagram`.
    phase: u8,
    table: Option<Table>,
    table_unresolved: Vec<String>,
    table_failed_keys: FailedKeys,
    /// Table line phase: 0 columns, 1 key, index, foreign key and check lines, 2 settings.
    table_phase: u8,
    /// The `{` of the open table, settings block and diagram.
    table_brace: Option<Pos>,
    settings_brace: Option<Pos>,
    /// Whether the open settings block has its `{`; otherwise it is reported at its keyword.
    settings_braced: bool,
    /// A repeated settings block: its lines are read only for syntax and collected in `detached_settings`; this is Go's detached block.
    settings_detached: bool,
    detached_settings: Option<Settings>,
    diagram_brace: Option<Pos>,
    diagram: Option<Diagram>,
    columns: usize,
    foreign_keys: usize,
    stopped: bool,
    /// The classes of the words read so far.
    marks: Vec<(Pos, Class)>,
    /// How many blocks were opened; a line that opens one is not inside the block it opens.
    opened: usize,
    /// Whether the opening line of the open diagram failed (R20).
    diagram_header_failed: bool,
    /// Whether the opening line of the open settings block failed (R20); cleared at its close.
    settings_header_failed: bool,
    /// Whether the line being read has a character that no token allows: its line fails, so it reports no order error.
    line_lexical: bool,
}

fn err(pos: Pos, rule: &'static str, message: impl Into<String>) -> Diag {
    Diag { pos, rule, message: message.into() }
}

/// A line without its line end, with the column of a bare CR in it.
type Line<'a> = (&'a str, Option<usize>);

/// Splits text into lines after the whole-text checks: at most 32 MiB and no
/// byte order mark. A bare CR is reported when parsing reaches its line.
fn lines(text: &str) -> Result<Vec<Line<'_>>, Diag> {
    let start = Pos { line: 1, column: 1 };
    if text.len() > MAX_BYTES {
        return Err(err(start, "limit", format!("document has {} bytes, more than {MAX_BYTES}", text.len())));
    }
    if text.starts_with('\u{feff}') {
        return Err(err(start, "encoding", "document starts with a byte order mark"));
    }
    let mut lines = Vec::new();
    let pieces: Vec<&str> = text.split('\n').collect();
    let last = pieces.len() - 1;
    for (index, raw) in pieces.iter().enumerate() {
        // A CR before an LF is the line end (R22); a CR at the end of the text is a bare CR.
        let line = if index < last { raw.strip_suffix('\r').unwrap_or(raw) } else { raw };
        let cr = line.find('\r').map(|cr| line[..cr].chars().count() + 1);
        lines.push((line, cr));
    }
    if text.ends_with('\n') {
        lines.pop();
    }
    Ok(lines)
}

/// What the first steps of `parse` read: the lines of the text, the tokens of the header line and
/// its document name token.
struct Head<'a> {
    lines: Vec<Line<'a>>,
    tokens: Vec<Token<'a>>,
    name: Token<'a>,
}

/// The first steps of `parse`: the lines of the text, a bare CR on the first line, and the header.
fn head(text: &str) -> Result<Head<'_>, Stopped> {
    if text.is_empty() {
        return Err(stopping(err(Pos { line: 1, column: 1 }, "header", "document is empty; the first line must be dbspec 1 <document>")));
    }
    let lines = lines(text).map_err(stopping)?;
    if let Some((_, Some(column))) = lines.first() {
        return Err(stopping(bare_cr(1, *column)));
    }
    let tokens = lines.first().map(|(l, _)| tokenize(l, 1)).unwrap_or_default();
    let name = *header(lines.first().map_or("", |(l, _)| l), &tokens).map_err(stopping)?;
    Ok(Head { lines, tokens, name })
}

/// The integer that a coordinate token of digits holds, or `Err` when it does not fit in `i32`.
fn coordinate_value(text: &str, negative: bool) -> Result<i32, ()> {
    let digits = text.trim_start_matches('0');
    // More digits than i128 holds are outside i32 too.
    let magnitude: i128 = if digits.is_empty() { 0 } else { digits.parse().map_err(|_too_long| ())? };
    i32::try_from(if negative { -magnitude } else { magnitude }).map_err(|_out_of_range| ())
}

/// The document name that the header step of `parse` reads from `text`. A header that does not parse stops with its
/// diagnostics. It runs the first steps of `parse` and stops after the header.
pub(crate) fn header_name(text: &str) -> Result<String, Stopped> {
    head(text).map(|head| head.name.text.to_owned())
}

pub(crate) fn parse(text: &str) -> Result<Syntax, Stopped> {
    let Head { lines, tokens: header_tokens, name } = head(text)?;
    let mut parser = Parser {
        diags: Vec::new(),
        declarations: Vec::new(),
        pending: Vec::new(),
        document: Document {
            name: Name { text: String::new(), pos: Pos::default() },
            uses: Vec::new(),
            tables: Vec::new(),
            diagrams: Vec::new(),
            trailing: Vec::new(),
            external: false,
        },
        failed_uses: Vec::new(),
        unresolved: Vec::new(),
        typeless: Vec::new(),
        table_typeless: Vec::new(),
        failed_keys: Vec::new(),
        header_failed: Vec::new(),
        table_header_failed: false,
        defaults: Vec::new(),
        table_defaults: Vec::new(),
        context: Context::Top,
        skip: 0,
        phase: 0,
        table: None,
        table_unresolved: Vec::new(),
        table_failed_keys: FailedKeys::default(),
        table_phase: 0,
        table_brace: None,
        settings_brace: None,
        settings_braced: false,
        settings_detached: false,
        detached_settings: None,
        diagram_brace: None,
        diagram: None,
        columns: 0,
        foreign_keys: 0,
        stopped: false,
        marks: Vec::new(),
        opened: 0,
        diagram_header_failed: false,
        settings_header_failed: false,
        line_lexical: false,
    };
    let header = parser.define(&name);
    parser.declare("document", vec![header.text.clone()], header.pos);
    parser.document.name = header;
    parser.mark(&header_tokens[0], Class::Keyword);
    for (index, (line, cr)) in lines.iter().enumerate().skip(1) {
        if let Some(column) = cr {
            parser.report(bare_cr(index + 1, *column));
            return Err(Stopped { diags: parser.diags, marks: Marks { classes: parser.marks, lexical_from: Some(index + 1), no_tokens: false } });
        }
        parser.line(line, index + 1);
        if parser.stopped {
            return Err(Stopped { diags: parser.diags, marks: Marks { classes: parser.marks, lexical_from: None, no_tokens: true } });
        }
    }
    parser.finish();
    Ok(Syntax {
        document: parser.document,
        failed_uses: parser.failed_uses,
        declarations: parser.declarations,
        unresolved: parser.unresolved,
        typeless: parser.typeless,
        failed_keys: parser.failed_keys,
        header_failed: parser.header_failed,
        defaults: parser.defaults,
        diags: parser.diags,
        marks: Marks { classes: parser.marks, lexical_from: None, no_tokens: false },
    })
}

fn codec_stage(stage: &str) -> Class {
    if CODEC_STAGES.contains(&stage) {
        Class::Keyword
    } else {
        Class::Word
    }
}

#[cfg(test)]
mod cursor_tests {
    use super::parse;

    #[test]
    fn parser_cursor_keeps_declaration_tokens_in_order() {
        let _case = polyspec_orm_testcase::case!();
        let parsed = parse("dbspec 1 shop\n\ntable cafe {\n  id i64\n}\n").expect("valid document parses");
        assert_eq!(parsed.document.tables[0].name.text, "cafe");
        assert_eq!(parsed.document.tables[0].columns[0].name.text, "id");
    }
}

fn bare_cr(line: usize, column: usize) -> Diag {
    err(Pos { line, column }, "encoding", "carriage return without a following line feed")
}

/// The header is exactly `dbspec`, a space, `1`, a space and the document
/// name; returns the name token. An error points at the first character that
/// departs from that form.
fn header<'t, 'a>(line: &'a str, tokens: &'t [Token<'a>]) -> Result<&'t Token<'a>, Diag> {
    const PREFIX: &str = "dbspec 1 ";
    const HEADER: &str = "the first line is exactly dbspec 1 <document>";
    let at = |column: usize, message: &str| err(Pos { line: 1, column }, "header", message);
    for (index, expected) in PREFIX.chars().enumerate() {
        match line.chars().nth(index) {
            Some(c) if c == expected => {}
            _ => return Err(at(index + 1, HEADER)),
        }
    }
    // Go's isHeaderNameRune: the name is a run of ASCII letters, digits and `_`, and the line ends after it.
    let rest = &line[PREFIX.len()..];
    let run = rest.bytes().take_while(|b| b.is_ascii_alphanumeric() || *b == b'_').count();
    if run == 0 {
        return Err(at(PREFIX.len() + 1, HEADER));
    }
    if run < rest.len() {
        return Err(at(PREFIX.len() + run + 1, HEADER));
    }
    match tokens.get(2) {
        Some(name) if matches!(name.kind, Kind::Word | Kind::Number) && name.pos.column == PREFIX.len() + 1 => Ok(name),
        _ => Err(at(PREFIX.len() + 1, HEADER)),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LineKind {
    Primary,
    Unique,
    Index,
    ForeignKey,
    Check,
    Settings,
}

fn line_kind(first: &Token) -> Option<LineKind> {
    match first.text {
        "primary" => Some(LineKind::Primary),
        "unique" => Some(LineKind::Unique),
        "index" => Some(LineKind::Index),
        "foreign" => Some(LineKind::ForeignKey),
        "check" => Some(LineKind::Check),
        "settings" => Some(LineKind::Settings),
        _ => None,
    }
}

impl Parser {
    /// Records the class of a consumed token. Only a word takes a class, except a name position, which takes any
    /// token of a name (R11).
    fn mark(&mut self, token: &Token<'_>, class: Class) {
        if token.kind == Kind::Word || class == Class::Name {
            self.marks.push((token.pos, class));
        }
    }

    /// Consumes the next token as a keyword and returns it.
    fn take_keyword<'t, 'a>(&mut self, cursor: &mut Cursor<'t, 'a>) -> Option<&'t Token<'a>> {
        let token = cursor.next()?;
        self.mark(token, Class::Keyword);
        Some(token)
    }

    fn report(&mut self, diag: Diag) {
        self.diags.push(diag);
    }

    /// The syntax error of the first token that the line does not allow, with what the position expects (Go's
    /// cursor.fail): `unexpected <token>, expected <what>`, or `line ends, expected <what>` at the end of the line.
    fn syntax(&mut self, cursor: &Cursor, expected: &str) {
        let diag = match cursor.peek() {
            Some(t) => err(t.pos, "syntax", format!("unexpected {}, expected {expected}", t.describe())),
            None => err(cursor.end, "syntax", format!("line ends, expected {expected}")),
        };
        self.report(diag);
    }

    fn stop(&mut self, pos: Pos, message: String) {
        self.report(err(pos, "limit", message));
        self.stopped = true;
    }

    fn comments(&mut self) -> Vec<String> {
        std::mem::take(&mut self.pending)
    }

    fn declare(&mut self, kind: &'static str, path: Vec<String>, pos: Pos) {
        self.declarations.push(Declaration { kind, path, pos, setting: None });
    }

    /// The name of the open table, or an empty name when the table line had no name (then a diagnostic exists).
    fn table_name(&self) -> String {
        self.table.as_ref().map_or_else(String::new, |t| t.name.text.clone())
    }

    /// Checks a name, defined or referenced, and returns it.
    fn define(&mut self, token: &Token) -> Name {
        self.check_name(token.text, token.pos);
        self.mark(token, Class::Name);
        Name { text: token.text.to_owned(), pos: token.pos }
    }

    fn check_name(&mut self, text: &str, pos: Pos) {
        if !name_format(text) {
            self.report(err(pos, "name.format", format!("name {} does not match [a-z][a-z0-9_]* or is a reserved word", go_quote(text))));
        }
        if text.len() > MAX_NAME_BYTES {
            self.report(err(pos, "name.length", format!("name {} has {} bytes, more than {MAX_NAME_BYTES}", go_quote(text), text.len())));
        }
    }

    /// Reads a name token and checks it. A malformed reference is reported
    /// here and not resolved further.
    fn name(&mut self, cursor: &mut Cursor, expected: &str) -> Option<Name> {
        match cursor.peek() {
            Some(t) if matches!(t.kind, Kind::Word | Kind::Number) => {
                cursor.next();
                Some(self.define(t))
            }
            _ => {
                self.syntax(cursor, expected);
                None
            }
        }
    }

    /// Reads a word that is not a name, such as a codec stage; `class` gives its class from its text.
    fn word(&mut self, cursor: &mut Cursor, class: fn(&str) -> Class, expected: &str) -> Option<Name> {
        match cursor.peek() {
            Some(t) if matches!(t.kind, Kind::Word | Kind::Number) => {
                cursor.next();
                self.mark(t, class(t.text));
                Some(Name { text: t.text.to_owned(), pos: t.pos })
            }
            _ => {
                self.syntax(cursor, expected);
                None
            }
        }
    }

    /// Reads the keyword or punctuation `text`; otherwise the syntax error expects `'<text>'`.
    fn expect(&mut self, cursor: &mut Cursor, text: &str) -> Option<()> {
        if cursor.peek_is(text) {
            if let Some(token) = cursor.next() {
                self.mark(token, Class::Keyword);
            }
            Some(())
        } else {
            self.syntax(cursor, &format!("'{text}'"));
            None
        }
    }

    /// The end of a setting line whose arguments are read: a token after them, such as the state of the per-state task_marker
    /// form, is a syntax error that shows the token as every runtime does (DBS-80), a string by its value and any other token by
    /// its text.
    fn end(&mut self, cursor: &Cursor) -> Option<()> {
        if cursor.peek().is_some() {
            self.syntax(cursor, "the end of the line");
            None
        } else {
            Some(())
        }
    }

    /// Reads one line. Its classes are dropped when the line is abandoned (R1: a syntax diagnostic on it), and when
    /// it is read inside a block whose opening line failed (R2, R20), which keeps lexical classes only.
    fn line(&mut self, line: &str, number: usize) {
        let (diags, marks, opened) = (self.diags.len(), self.marks.len(), self.opened);
        let failed = self.in_failed_block();
        self.read_line(line, number);
        let abandoned = self.diags[diags..].iter().any(|d| d.rule == "syntax" && d.pos.line == number);
        // A block whose opening line is abandoned failed to open (R1, R20), even when its brace was read.
        if abandoned && self.opened != opened {
            match self.context {
                Context::Top => {}
                Context::Table => self.table_header_failed = true,
                Context::Settings => self.settings_header_failed = true,
                Context::Diagram => self.diagram_header_failed = true,
            }
        }
        if abandoned || (failed && self.opened == opened) {
            self.marks.truncate(marks);
        }
    }

    fn in_failed_block(&self) -> bool {
        match self.context {
            Context::Top => false,
            Context::Table => self.table_header_failed,
            Context::Settings => self.table_header_failed || self.settings_header_failed,
            Context::Diagram => self.diagram_header_failed,
        }
    }

    fn read_line(&mut self, line: &str, number: usize) {
        let trimmed = line.trim_start_matches(' ');
        if trimmed.is_empty() {
            return;
        }
        if trimmed.starts_with('#') {
            if self.skip == 0 {
                self.pending.push(trimmed.to_owned());
            }
            return;
        }
        let mut tokens = tokenize(line, number);
        // A line of the top level with a bad character is still read without it (Go's lexRecover), so that a
        // table header keeps its table; the bad character is reported once, and it is the syntax diagnostic of its
        // line: a syntax failure that the rest of the line then gives is not reported, as Go's cursor reports its
        // lexical error in place of its first failure.
        let mut lexical = None;
        self.line_lexical = false;
        if matches!(self.context, Context::Top) {
            if let Some(bad) = tokens.iter().find(|t| t.kind == Kind::Invalid).copied() {
                self.report(err(bad.pos, "syntax", bad.lexical_message()));
                lexical = Some(self.diags.len());
                self.line_lexical = true;
                tokens.retain(|t| t.kind != Kind::Invalid);
                if tokens.is_empty() {
                    return;
                }
            }
        }
        if self.skip > 0 {
            if tokens.len() == 1 && tokens[0].is("}") {
                self.skip -= 1;
            } else if tokens.last().is_some_and(|t| t.is("{")) {
                self.skip += 1;
            }
            return;
        }
        if let Some(bad) = tokens.iter().find(|t| t.kind == Kind::Invalid) {
            self.report(err(bad.pos, "syntax", bad.lexical_message()));
            // The line keeps the kind and name that its words give.
            let mut words = tokens.iter().filter(|t| t.kind != Kind::Invalid);
            if let (Context::Table, Some(word)) = (&self.context, words.next()) {
                match line_kind(word) {
                    Some(LineKind::Primary) => self.fail_key(true),
                    Some(LineKind::Unique | LineKind::Index) => self.fail_key(false),
                    // A foreign key line that fails fails its name, as the syntax error of a line does (Go's markFailed).
                    Some(LineKind::ForeignKey) => {
                        if let Some(name) = words.next().filter(|n| n.kind == Kind::Word) {
                            self.table_unresolved.push(name.text.to_owned());
                        }
                    }
                    Some(_) => {}
                    None if word.kind == Kind::Word => self.table_unresolved.push(word.text.to_owned()),
                    None => {}
                }
            }
            if tokens.last().is_some_and(|t| t.is("{")) {
                self.skip = 1;
            }
            return;
        }
        match self.context {
            Context::Top => self.top_line(&tokens),
            Context::Table => self.table_line(&tokens),
            Context::Settings => self.setting_line(&tokens),
            Context::Diagram => self.diagram_line(&tokens),
        }
        if let Some(after) = lexical {
            let mut index = 0;
            self.diags.retain(|d| {
                index += 1;
                index <= after || d.rule != "syntax" || d.pos.line != number
            });
        }
    }

    fn top_line(&mut self, tokens: &[Token]) {
        let first = &tokens[0];
        let mut cursor = Cursor::new(tokens);
        match first.text {
            "use" if first.kind == Kind::Word => {
                let before = self.document.uses.len();
                self.use_line(&mut cursor);
                // Go reports the order of a use line once the line parsed.
                if self.document.uses.len() != before && self.phase > 0 && !self.line_lexical {
                    self.report(err(first.pos, "order", "use lines come before table and diagram blocks"));
                }
                if self.document.uses.len() == before {
                    // The words of a use line that fails are names of a failed line.
                    self.failed_uses.extend(tokens.iter().skip(2).filter(|t| t.kind == Kind::Word).map(|t| t.text.to_owned()));
                }
            }
            "table" if first.kind == Kind::Word => {
                let out_of_order = self.phase > 1;
                self.phase = self.phase.max(1);
                self.open_table(&mut cursor);
                // Go reports the order of a table line once the line parsed.
                if out_of_order && self.table_brace.is_some() && !self.line_lexical && !self.stopped {
                    self.report(err(first.pos, "order", "table blocks come before diagram blocks"));
                }
            }
            "diagram" if first.kind == Kind::Word => {
                self.phase = 2;
                self.open_diagram(&mut cursor);
            }
            _ => self.syntax(&cursor, "'use', 'table' or 'diagram'"),
        }
    }

    fn use_line(&mut self, cursor: &mut Cursor) {
        self.take_keyword(cursor);
        let comments = self.comments();
        let Some(document) = self.name(cursor, "a document name") else { return };
        if self.expect(cursor, "{").is_none() {
            return;
        }
        let mut tables = Vec::new();
        loop {
            let Some(table) = self.name(cursor, "a table name") else { return };
            tables.push(table);
            if cursor.peek_is("}") {
                cursor.next();
                if self.end(cursor).is_none() {
                    return;
                }
                break;
            }
            if !cursor.peek_is(",") {
                self.syntax(cursor, "',' or '}'");
                return;
            }
            cursor.next();
        }
        self.declare("use", vec![document.text.clone()], document.pos);
        for table in &tables {
            self.declare("use_table", vec![document.text.clone(), table.text.clone()], table.pos);
        }
        self.document.uses.push(Use { comments, document, tables });
    }

    /// `<name> {` after `table` or `diagram`. The block opens even when the
    /// line is malformed, so its lines are still read.
    fn block_header(&mut self, cursor: &mut Cursor, keyword: Pos, expected: &str) -> (Name, Option<Pos>) {
        match self.name(cursor, expected) {
            Some(name) => {
                let brace = cursor.here();
                if self.expect(cursor, "{").is_some() && self.end(cursor).is_some() {
                    return (name, Some(brace));
                }
                (name, None)
            }
            None => (Name { text: String::new(), pos: keyword }, None),
        }
    }

    fn open_table(&mut self, cursor: &mut Cursor) {
        let keyword = self.take_keyword(cursor).map_or(Pos::default(), |t| t.pos);
        if self.document.tables.len() >= MAX_TABLES {
            self.stop(keyword, format!("document has more than {MAX_TABLES} tables"));
            return;
        }
        let comments = self.comments();
        let (name, brace) = self.block_header(cursor, keyword, "a table name");
        self.declare("table", vec![name.text.clone()], name.pos);
        self.table_header_failed = brace.is_none();
        self.table_brace = brace;
        self.settings_brace = None;
        self.table = Some(Table {
            comments,
            name,
            columns: Vec::new(),
            primary: Vec::new(),
            uniques: Vec::new(),
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            checks: Vec::new(),
            settings: None,
            closing: Vec::new(),
        });
        self.table_unresolved = Vec::new();
        self.table_failed_keys = FailedKeys::default();
        self.table_defaults = Vec::new();
        self.table_typeless = Vec::new();
        self.table_phase = 0;
        self.opened += 1;
        self.context = Context::Table;
    }

    fn close_table(&mut self) {
        if let Some(mut table) = self.table.take() {
            if table.settings.is_some() && matches!(self.context, Context::Settings) {
                if let Some(settings) = table.settings.as_mut() {
                    settings.closing.append(&mut self.pending);
                }
            } else {
                table.closing = self.comments();
            }
            self.document.tables.push(table);
            self.unresolved.push(std::mem::take(&mut self.table_unresolved));
            self.typeless.push(std::mem::take(&mut self.table_typeless));
            self.failed_keys.push(std::mem::take(&mut self.table_failed_keys));
            self.header_failed.push(std::mem::take(&mut self.table_header_failed));
            self.defaults.push(std::mem::take(&mut self.table_defaults));
        }
        self.settings_header_failed = false;
        self.context = Context::Top;
    }

    fn open_diagram(&mut self, cursor: &mut Cursor) {
        let keyword = self.take_keyword(cursor).map_or(Pos::default(), |t| t.pos);
        let comments = self.comments();
        let (name, brace) = self.block_header(cursor, keyword, "a diagram name");
        self.diagram_header_failed = brace.is_none();
        self.declare("diagram", vec![name.text.clone()], name.pos);
        self.diagram_brace = brace;
        self.diagram = Some(Diagram { comments, name, placements: Vec::new(), closing: Vec::new() });
        self.opened += 1;
        self.context = Context::Diagram;
    }

    fn close_diagram(&mut self) {
        if let Some(mut diagram) = self.diagram.take() {
            diagram.closing = self.comments();
            self.document.diagrams.push(diagram);
        }
        self.context = Context::Top;
    }

    /// A closing `}` line; reports extra tokens.
    fn closing(&mut self, tokens: &[Token]) -> bool {
        if !tokens[0].is("}") {
            return false;
        }
        if let Some(extra) = tokens.get(1) {
            self.report(err(extra.pos, "syntax", format!("unexpected {}, expected the end of the line", extra.describe())));
        }
        true
    }

    fn table_line(&mut self, tokens: &[Token]) {
        if self.closing(tokens) {
            self.close_table();
            return;
        }
        // The `table` and `diagram` lines inside a table block are column lines as in Go (they neither open nor close the block). A syntax error on such a line is treated as a column line syntax error.
        let first = &tokens[0];
        let kind = if first.kind == Kind::Word { line_kind(first) } else { None };
        if kind.is_some() {
            self.mark(first, Class::Keyword);
        }
        let phase = match kind {
            None => 0,
            Some(LineKind::Settings) => 2,
            Some(_) => 1,
        };
        // Go reports order on the keyword of a repeated block only when the line has the correct form (`settings {` only).
        let well_formed = tokens.len() == 2 && tokens[1].is("{");
        let second_settings = kind == Some(LineKind::Settings) && well_formed && self.table.as_ref().is_some_and(|t| t.settings.is_some());
        let mut cursor = Cursor::new(tokens);
        if second_settings {
            self.report(err(first.pos, "order", "a table has at most one settings block, after its other lines"));
        } else if kind == Some(LineKind::Settings) {
            self.table_phase = phase;
        }
        let before = self.diags.len();
        match kind {
            Some(LineKind::Primary) => self.primary_line(&mut cursor),
            Some(LineKind::Unique) => self.unique_line(&mut cursor),
            Some(LineKind::Index) => self.index_line(&mut cursor),
            Some(LineKind::ForeignKey) => self.foreign_key_line(&mut cursor),
            Some(LineKind::Check) => self.check_line(&mut cursor),
            Some(LineKind::Settings) => self.open_settings(&mut cursor),
            None => self.column_line_in_order(first, &mut cursor),
        }
        // Go reports the order of a key, index, foreign key or check line, and enters their phase, once the line parsed.
        let parsed = !self.stopped && !self.diags[before..].iter().any(|d| d.rule == "syntax" && d.pos.line == first.pos.line);
        if parsed && phase == 1 {
            if self.table_phase > 1 {
                self.report(err(first.pos, "order", "key, index, foreign key and check lines come before the settings block"));
            } else {
                self.table_phase = 1;
            }
        }
    }

    fn table_mut(&mut self) -> &mut Table {
        self.table.as_mut().expect("a table line is read inside a table")
    }

    /// Parses a column line after the key lines of its table. Go reports `order` only when the
    /// line parses (`columnLine` after `c.done`), so a line with a syntax error gets `syntax` alone.
    fn column_line_in_order(&mut self, first: &Token, cursor: &mut Cursor) {
        let before = self.diags.len();
        self.column_line(cursor);
        let syntax = self.diags[before..].iter().any(|d| d.rule == "syntax");
        // Go does not check the name and type of a line with a syntax error: on this line only the syntax error is kept.
        if syntax {
            let later = self.diags.split_off(before);
            self.diags.extend(later.into_iter().filter(|d| d.rule == "syntax"));
        }
        if self.table_phase > 0 && !syntax && !self.stopped {
            self.report(err(first.pos, "order", "column lines come before key, index, foreign key, check and settings lines"));
        }
    }

    fn column_line(&mut self, cursor: &mut Cursor) {
        let first = cursor.tokens[0];
        let table_columns = self.table.as_ref().map_or(0, |t| t.columns.len() + self.table_unresolved.len());
        if table_columns >= MAX_TABLE_COLUMNS {
            self.stop(first.pos, format!("table has more than {MAX_TABLE_COLUMNS} columns"));
            return;
        }
        if self.columns >= MAX_COLUMNS {
            self.stop(first.pos, format!("document has more than {MAX_COLUMNS} columns"));
            return;
        }
        self.columns += 1;
        match self.column(cursor) {
            Some(column) => {
                let table = self.table_name();
                self.declare("column", vec![table, column.name.text.clone()], column.name.pos);
                self.table_mut().columns.push(column)
            }
            None => {
                if matches!(first.kind, Kind::Word | Kind::Number) {
                    self.table_unresolved.push(first.text.to_owned());
                }
            }
        }
    }

    /// Parses a column line; `None` when the line or its type is invalid.
    fn column(&mut self, cursor: &mut Cursor) -> Option<Column> {
        let comments = self.comments();
        let name = self.name(cursor, "a column name, key, index, foreign key, check, settings or '}'")?;
        let ty = self.column_type(cursor)?;
        let nullable = cursor.peek_is("null");
        if nullable {
            self.take_keyword(cursor);
        }
        let identity = cursor.peek_is("identity").then(|| self.take_keyword(cursor).map(|t| t.pos)).flatten();
        let mut default = None;
        let mut default_keyword = None;
        if cursor.peek_is("default") {
            default_keyword = self.take_keyword(cursor).map(|t| t.pos);
            let value_pos = cursor.here();
            let value = match cursor.peek() {
                Some(t) if t.is("-") => {
                    cursor.next();
                    match cursor.peek() {
                        Some(n) if n.kind == Kind::Number => {
                            cursor.next();
                            Value::Number { negative: true, text: n.text.to_owned() }
                        }
                        _ => {
                            self.syntax(cursor, "a number after '-'");
                            return None;
                        }
                    }
                }
                Some(t) if t.kind == Kind::Number => {
                    cursor.next();
                    Value::Number { negative: false, text: t.text.to_owned() }
                }
                Some(t) if t.kind == Kind::Word => {
                    cursor.next();
                    // A value position: `true`, `false`, `null` and `now` are keywords, any other word is `word` (R6, R18).
                    let class = if matches!(t.text, "true" | "false" | "null" | "now") { Class::Keyword } else { Class::Word };
                    self.mark(t, class);
                    Value::Word(t.text.to_owned())
                }
                Some(t) if t.kind == Kind::Str => {
                    cursor.next();
                    Value::Str(t.string_value())
                }
                _ => {
                    self.syntax(cursor, "a default value");
                    return None;
                }
            };
            default = Some((value_pos, Some(value)));
        }
        self.end(cursor)?;
        if let Some((_, Some(_))) = &default {
            self.table_defaults.push(DefaultToken { column: name.text.clone() });
        }
        if let Some(pos) = identity {
            if nullable {
                self.report(err(pos, "column", "an identity column cannot be null"));
            } else if let Some(other) = ty.filter(|t| *t != Type::I64) {
                self.report(err(pos, "column", format!("an identity column has type i64, not {}", other.render())));
            }
            if let Some(keyword) = default_keyword {
                self.report(err(keyword, "column", "an identity column has no default"));
            }
        }
        let Some(ty) = ty else {
            // The line's syntax is correct and only its type is wrong. Go keeps this column (only the type is invalid), so its name is recorded.
            self.table_typeless.push((name.text.to_owned(), nullable));
            return None;
        };
        let default = match (default, default_keyword) {
            (Some(_), Some(keyword)) if identity.is_none() && matches!(ty, Type::Text | Type::Bytes) => {
                self.report(err(keyword, "column", format!("a {} column has no default", ty.render())));
                None
            }
            (Some((pos, value)), Some(_)) if identity.is_none() => {
                let checked = value.as_ref().map(|value| (default_literal(ty, value), value.describe()));
                match checked {
                    Some((Ok(text), _)) if text == "now" => Some(DefaultValue::Now),
                    Some((Ok(text), _)) => Some(DefaultValue::Literal(text)),
                    Some((Err(_), shown)) => {
                        self.report(err(pos, "column", format!("default {shown} is not a literal of type {}", ty.render())));
                        None
                    }
                    None => None,
                }
            }
            _ => None,
        };
        Some(Column { comments, name, ty, nullable, identity, default })
    }

    /// Reads a type with its parameters. The outer `None` abandons the line; the
    /// inner `None` is a type error that was reported.
    fn column_type(&mut self, cursor: &mut Cursor) -> Option<Option<Type>> {
        let Some(word) = cursor.peek().filter(|t| t.kind == Kind::Word) else {
            self.syntax(cursor, "a type");
            return None;
        };
        cursor.next();
        self.mark(word, Class::Type);
        let mut params: Option<Vec<Option<u32>>> = None;
        let mut malformed = false;
        if cursor.peek_is("(") {
            cursor.next();
            let mut values = Vec::new();
            // As in Go, reads values (numbers, words, `-` numbers) and separators. If another token appears in a value position, or the separator is not `,` or `)`,
            // it is a syntax error (as in Go, a type error is reported only when the line matches the syntax).
            loop {
                match cursor.peek() {
                    Some(t) if t.kind == Kind::Number && !t.text.contains('.') => {
                        // A parameter too large for a number is out of the type's range, a type error as in Go.
                        cursor.next();
                        // A parameter too large for u32 is outside the range of every type: it has no value.
                        match t.text.parse::<u32>() {
                            Ok(value) => values.push(Some(value)),
                            Err(_out_of_range) => values.push(None),
                        }
                    }
                    Some(t) if t.kind == Kind::Number || t.kind == Kind::Word => {
                        cursor.next();
                        malformed = true;
                        values.push(None);
                    }
                    Some(t) if t.is("-") => {
                        cursor.next();
                        match cursor.peek() {
                            Some(n) if n.kind == Kind::Number => {
                                cursor.next();
                                malformed = true;
                                values.push(None);
                            }
                            _ => {
                                self.syntax(cursor, "a number after '-'");
                                return None;
                            }
                        }
                    }
                    _ => {
                        self.syntax(cursor, "a type parameter");
                        return None;
                    }
                }
                match cursor.peek() {
                    Some(t) if t.is(",") => {
                        cursor.next();
                    }
                    Some(t) if t.is(")") => {
                        cursor.next();
                        break;
                    }
                    _ => {
                        self.syntax(cursor, "',' or ')'");
                        return None;
                    }
                }
            }
            params = Some(values);
        }
        let in_range = |v: Option<u32>, low: u32, high: u32| v.filter(|v| (low..=high).contains(v));
        let ty = if word.kind != Kind::Word || malformed {
            None
        } else {
            match (word.text, params.as_deref()) {
                ("i16", None) => Some(Type::I16),
                ("i32", None) => Some(Type::I32),
                ("i64", None) => Some(Type::I64),
                ("bool", None) => Some(Type::Bool),
                ("f64", None) => Some(Type::F64),
                ("text", None) => Some(Type::Text),
                ("bytes", None) => Some(Type::Bytes),
                ("uuid", None) => Some(Type::Uuid),
                ("date", None) => Some(Type::Date),
                ("decimal", Some([p, s])) => match (in_range(*p, 1, 18), *s) {
                    (Some(p), Some(s)) if s <= p => Some(Type::Decimal(p as u8, s as u8)),
                    _ => None,
                },
                ("varchar", Some([n])) => in_range(*n, 1, 16383).map(|n| Type::Varchar(n as u16)),
                ("time", Some([p])) => in_range(*p, 0, 6).map(|p| Type::Time(p as u8)),
                ("datetime", Some([p])) => in_range(*p, 0, 6).map(|p| Type::DateTime(p as u8)),
                _ => None,
            }
        };
        if ty.is_none() {
            let message = match word.text {
                _ if word.kind != Kind::Word => format!("type {} is not a dbspec type", go_quote(word.text)),
                "i16" | "i32" | "i64" | "bool" | "f64" | "text" | "bytes" | "uuid" | "date" => format!("{} takes no parameters", word.text),
                "decimal" => "decimal(p,s) needs 1 <= p <= 18 and 0 <= s <= p".to_string(),
                "varchar" => "varchar(n) needs 1 <= n <= 16383".to_string(),
                "time" | "datetime" => format!("{}(p) needs 0 <= p <= 6", word.text),
                _ => format!("type {} is not a dbspec type", go_quote(word.text)),
            };
            self.report(err(word.pos, "type", message));
        }
        Some(ty)
    }

    /// Reads `( <item>, ... )`, one or more items that `item` reads.
    fn parenthesized<T>(&mut self, cursor: &mut Cursor, mut item: impl FnMut(&mut Self, &mut Cursor) -> Option<T>) -> Option<Vec<T>> {
        self.expect(cursor, "(")?;
        let mut items = Vec::new();
        loop {
            items.push(item(self, cursor)?);
            if cursor.peek_is(")") {
                cursor.next();
                return Some(items);
            }
            if !cursor.peek_is(",") {
                self.syntax(cursor, "',' or ')'");
                return None;
            }
            cursor.next();
        }
    }

    /// Reads the `(<column>, ...)` of an audit list. The caller checks the names.
    fn audit_columns(&mut self, cursor: &mut Cursor) -> Option<Vec<Name>> {
        self.parenthesized(cursor, |p, cursor| p.word(cursor, |_| Class::Name, "a column name"))
    }

    /// `( <column> [asc|desc], ... )`; directions only when `directions` is set.
    fn column_list(&mut self, cursor: &mut Cursor, directions: bool) -> Option<Vec<(Name, bool)>> {
        self.parenthesized(cursor, |p, cursor| {
            let name = p.name(cursor, "a column name")?;
            let mut desc = false;
            if directions && (cursor.peek_is("asc") || cursor.peek_is("desc")) {
                desc = p.take_keyword(cursor).is_some_and(|t| t.text == "desc");
            }
            Some((name, desc))
        })
    }

    /// Knows a key or index line that failed, so the rules that depend on its columns report nothing. A failed
    /// primary key line is `primary` only; a failed unique or index line is `any` only (Go's failedPK and failedKey).
    fn fail_key(&mut self, primary: bool) {
        if primary {
            self.table_failed_keys.primary = true;
        } else {
            self.table_failed_keys.any = true;
        }
    }

    fn primary_line(&mut self, cursor: &mut Cursor) {
        if self.primary_key(cursor).is_none() {
            self.fail_key(true);
        }
    }

    fn primary_key(&mut self, cursor: &mut Cursor) -> Option<()> {
        let comments = self.comments();
        let pos = cursor.next().map_or(Pos::default(), |t| t.pos);
        self.expect(cursor, "key")?;
        let columns = self.column_list(cursor, false)?;
        self.end(cursor)?;
        let columns = columns.into_iter().map(|(n, _)| n).collect();
        let table = self.table_name();
        self.declare("constraint", vec![table, "primary key".to_owned()], pos);
        self.table_mut().primary.push(PrimaryKey { comments, pos, columns });
        Some(())
    }

    fn unique_line(&mut self, cursor: &mut Cursor) {
        if self.unique(cursor).is_none() {
            self.fail_key(false);
        }
    }

    fn unique(&mut self, cursor: &mut Cursor) -> Option<()> {
        let comments = self.comments();
        cursor.next();
        let name = self.name(cursor, "a unique name")?;
        let columns = self.column_list(cursor, false)?;
        self.end(cursor)?;
        let columns = columns.into_iter().map(|(n, _)| n).collect();
        let table = self.table_name();
        self.declare("constraint", vec![table, name.text.clone()], name.pos);
        self.table_mut().uniques.push(Unique { comments, name, columns });
        Some(())
    }

    fn index_line(&mut self, cursor: &mut Cursor) {
        if self.index(cursor).is_none() {
            self.fail_key(false);
        }
    }

    fn index(&mut self, cursor: &mut Cursor) -> Option<()> {
        let comments = self.comments();
        cursor.next();
        let name = self.name(cursor, "a index name")?;
        let columns = self.column_list(cursor, true)?;
        self.end(cursor)?;
        let table = self.table_name();
        self.declare("constraint", vec![table, name.text.clone()], name.pos);
        self.table_mut().indexes.push(Index { comments, name, columns });
        Some(())
    }

    /// Reads a foreign key action. A word that is not restrict, cascade or set_null is returned with its
    /// position, for the foreign_key error, and acts as restrict, which propagates nothing as Go's does.
    fn action(&mut self, cursor: &mut Cursor) -> Option<(Action, Option<(Pos, String)>)> {
        let (kind, text, pos) = match cursor.peek() {
            Some(t) => (t.kind, t.text, t.pos),
            None => {
                self.syntax(cursor, "an action");
                return None;
            }
        };
        let action = match (kind, text) {
            (Kind::Word, "restrict") => (Action::Restrict, None),
            (Kind::Word, "cascade") => (Action::Cascade, None),
            (Kind::Word, "set_null") => (Action::SetNull, None),
            (Kind::Word | Kind::Number, other) => (Action::Restrict, Some((pos, other.to_owned()))),
            _ => {
                self.syntax(cursor, "an action");
                return None;
            }
        };
        let known = kind == Kind::Word && matches!(text, "restrict" | "cascade" | "set_null");
        if let Some(token) = cursor.next() {
            if known {
                self.mark(token, Class::Keyword);
            }
        }
        Some(action)
    }

    fn foreign_key_line(&mut self, cursor: &mut Cursor) {
        let keyword = cursor.next().map_or(Pos::default(), |t| t.pos);
        if self.foreign_keys >= MAX_FOREIGN_KEYS {
            self.stop(keyword, format!("document has more than {MAX_FOREIGN_KEYS} foreign keys"));
            return;
        }
        self.foreign_keys += 1;
        let comments = self.comments();
        if self.expect(cursor, "key").is_none() {
            return;
        }
        let Some(name) = self.name(cursor, "a foreign key name") else { return };
        match self.foreign_key_rest(cursor) {
            Some((columns, table, references, on_delete, on_update, unknown)) => {
                for (pos, text) in unknown {
                    self.report(err(pos, "foreign_key", format!("action {} is not restrict, cascade or set_null", go_quote(&text))));
                }
                let columns = columns.into_iter().map(|(n, _)| n).collect();
                let references = references.into_iter().map(|(n, _)| n).collect();
                let owner = self.table_name();
                self.declare("constraint", vec![owner, name.text.clone()], name.pos);
                self.table_mut().foreign_keys.push(ForeignKey { comments, name, columns, table, references, on_delete, on_update });
            }
            // A failed foreign key line fails its name: references to it report nothing more (Go's markFailed).
            None => self.table_unresolved.push(name.text.to_owned()),
        }
    }

    /// The rest of a foreign key line after its name; `None` when the line fails. The unknown actions are returned
    /// with their positions, for the foreign_key error of an accepted line.
    #[expect(clippy::type_complexity, reason = "the tuple is the parts of one foreign key line, which its single caller takes apart at once")]
    fn foreign_key_rest(&mut self, cursor: &mut Cursor) -> Option<(Vec<(Name, bool)>, Name, Vec<(Name, bool)>, Action, Action, Vec<(Pos, String)>)> {
        let columns = self.column_list(cursor, false)?;
        self.expect(cursor, "references")?;
        let table = self.name(cursor, "a table name")?;
        let references = self.column_list(cursor, false)?;
        let mut on_delete = Action::Restrict;
        let mut on_update = Action::Restrict;
        let mut unknown = Vec::new();
        if cursor.peek_is("on") && cursor.tokens.get(cursor.at + 1).is_some_and(|t| t.is("delete")) {
            self.take_keyword(cursor);
            self.take_keyword(cursor);
            let (action, bad) = self.action(cursor)?;
            on_delete = action;
            unknown.extend(bad);
        }
        // Go reads `on` here as the start of `on update`, whatever follows it.
        if cursor.peek_is("on") {
            self.take_keyword(cursor);
            self.expect(cursor, "update")?;
            let (action, bad) = self.action(cursor)?;
            on_update = action;
            unknown.extend(bad);
        }
        self.end(cursor)?;
        Some((columns, table, references, on_delete, on_update, unknown))
    }

    fn check_line(&mut self, cursor: &mut Cursor) {
        let comments = self.comments();
        cursor.next();
        let Some(name) = self.name(cursor, "a check name") else { return };
        if let Some(bad) = cursor.tokens[..cursor.at].iter().find(|t| t.kind == Kind::Invalid) {
            self.report(err(bad.pos, "syntax", bad.lexical_message()));
            return;
        }
        if self.expect(cursor, "(").is_none() {
            return;
        }
        let rest = &cursor.tokens[cursor.at..];
        // Go: the tokens after `(` end with `)`; otherwise the line fails at its end.
        if rest.last().is_none_or(|t| !t.is(")")) {
            self.report(err(cursor.end, "syntax", "line ends, expected ')' at the end of the check"));
            return;
        }
        // Keep the final `)` for the check line itself. A nested group that is missing its close must report at this
        // token instead of consuming it as the group's close and reporting one column past the line.
        let closing = rest.last().expect("the check line ends with `)`");
        let expression_tokens = &rest[..rest.len() - 1];
        let mut parser = CheckParser::new(expression_tokens, closing.pos);
        let result = parser.expression().and_then(|expr| {
            let at = parser.position();
            match expression_tokens.get(at) {
                Some(t) => Err(not_allowed(t)),
                None => Ok(expr),
            }
        });
        let consumed = parser.position().min(expression_tokens.len());
        for token in &expression_tokens[..consumed] {
            if token.kind == Kind::Word {
                let class = if KEYWORDS.contains(&token.text) { Class::Keyword } else { Class::Name };
                self.mark(token, class);
            }
        }
        match result {
            Ok(expr) => {
                let owner = self.table_name();
                self.declare("constraint", vec![owner, name.text.clone()], name.pos);
                self.table_mut().checks.push(Check { comments, name, expr })
            }
            Err((pos, message)) => self.report(err(pos, "check", message)),
        }
    }

    /// `settings {`. A repeated block is read for syntax only (Go's detached block): its lines are not attached to a table and are not checked.
    /// Even if the header fails, the block stays open, as in Go.
    fn open_settings(&mut self, cursor: &mut Cursor) {
        let keyword = self.take_keyword(cursor).map_or(Pos::default(), |t| t.pos);
        let comments = self.comments();
        let brace = cursor.here();
        let opened = self.expect(cursor, "{").is_some();
        let ended = opened && self.end(cursor).is_some();
        // The block's opening line failed when it has no `{` or text after it (R20): its lines keep lexical classes.
        self.settings_header_failed = !ended;
        // Go's open position: the `{` read, or the keyword if there is none.
        self.settings_brace = Some(if opened { brace } else { keyword });
        self.settings_braced = opened;
        let block = Settings { comments, lines: Vec::new(), closing: Vec::new() };
        self.settings_detached = self.table.as_ref().is_some_and(|t| t.settings.is_some());
        if self.settings_detached {
            self.detached_settings = Some(block);
        } else {
            self.table_mut().settings = Some(block);
        }
        self.opened += 1;
        self.context = Context::Settings;
    }

    /// A settings block that reads lines: either the first block of a table, or the detached block of a repeated block.
    fn settings_target(&mut self) -> Option<&mut Settings> {
        if self.settings_detached {
            self.detached_settings.as_mut()
        } else {
            self.table.as_mut().and_then(|t| t.settings.as_mut())
        }
    }

    fn setting_line(&mut self, tokens: &[Token]) {
        if self.closing(tokens) {
            let closing = self.comments();
            if let Some(settings) = self.settings_target() {
                settings.closing = closing;
            }
            self.settings_header_failed = false;
            self.context = Context::Table;
            return;
        }
        // A `table` or `diagram` line inside a settings block is an unknown setting, as in Go. It does not close the block.
        let mut cursor = Cursor::new(tokens);
        let comments = self.comments();
        let keyword = tokens[0];
        if keyword.kind != Kind::Word {
            self.syntax(&cursor, "a setting or '}'");
            return;
        }
        self.mark(&keyword, Class::Setting);
        cursor.next();
        let setting = match (keyword.kind, keyword.text) {
            (Kind::Word, "entity") => self.name(&mut cursor, "an entity name").map(Setting::Entity),
            (Kind::Word, "updated") => self.name(&mut cursor, COLUMN).map(Setting::Updated),
            (Kind::Word, "soft_delete") => self.name(&mut cursor, COLUMN).map(Setting::SoftDelete),
            (Kind::Word, "aes_version") => self.name(&mut cursor, COLUMN).map(Setting::AesVersion),
            (Kind::Word, "select") => self.expect(&mut cursor, "explicit").and_then(|_| {
                let mut columns = vec![self.name(&mut cursor, COLUMN)?];
                while cursor.peek().is_some() {
                    columns.push(self.name(&mut cursor, COLUMN)?);
                }
                Some(Setting::SelectExplicit(columns))
            }),
            (Kind::Word, "codec") => self.name(&mut cursor, COLUMN).and_then(|column| {
                let mut stages = vec![self.word(&mut cursor, codec_stage, "a codec stage")?];
                while cursor.peek().is_some() {
                    stages.push(self.word(&mut cursor, codec_stage, "a codec stage")?);
                }
                // ordered_json is the name of the stage json in the language implementations, with the same encoding
                // (CORE-61), so the core reads it as json and its canonical form writes json.
                for stage in &mut stages {
                    if stage.text == LEGACY_JSON_STAGE {
                        stage.text = String::from("json");
                    }
                }
                for (index, stage) in stages.iter().enumerate() {
                    if !CODEC_STAGES.contains(&stage.text.as_str()) {
                        self.report(err(stage.pos, "setting", format!("codec stage {} is unknown", go_quote(&stage.text))));
                    } else if stage.text == "json" && index > 0 {
                        self.report(err(stage.pos, "setting", "json is the first codec stage"));
                    }
                }
                Some(Setting::Codec(column, stages))
            }),
            (Kind::Word, "blind_index") => {
                self.name(&mut cursor, "the AES column").and_then(|aes| Some(Setting::BlindIndex(aes, self.name(&mut cursor, "the index column")?)))
            }
            (Kind::Word, "navigation") => self.name(&mut cursor, "a foreign key name").and_then(|key| {
                let child = self.name(&mut cursor, "the child relation name")?;
                let parent = self.name(&mut cursor, "the parent relation name")?;
                Some(Setting::Navigation(key, child, parent))
            }),
            (Kind::Word, "markdown") => self.name(&mut cursor, COLUMN).map(Setting::Markdown),
            (Kind::Word, "store") => self.store(&mut cursor),
            (Kind::Word, "title") => self.name(&mut cursor, COLUMN).map(Setting::Title),
            (Kind::Word, "body") => self.name(&mut cursor, COLUMN).map(Setting::Body),
            (Kind::Word, "order") => self.name(&mut cursor, COLUMN).map(Setting::Order),
            (Kind::Word, "task_marker") => self.name(&mut cursor, COLUMN).map(Setting::TaskMarker),
            (Kind::Word, "immutable") => Some(Setting::Immutable),
            (Kind::Word, "audit") => (|| {
                self.expect(&mut cursor, "into")?;
                let into = self.name(&mut cursor, "the history table")?;
                self.expect(&mut cursor, "column")?;
                let column = self.name(&mut cursor, "the audit column")?;
                self.expect(&mut cursor, "references")?;
                let references = self.name(&mut cursor, "the audit record table")?;
                self.expect(&mut cursor, "action")?;
                let action = self.name(&mut cursor, "the action column")?;
                self.expect(&mut cursor, "previous")?;
                let previous = self.name(&mut cursor, "the previous column")?;
                let mut tables = None;
                if cursor.peek_is("tables") {
                    self.word(&mut cursor, |_| Class::Keyword, "'tables'")?;
                    let table = self.name(&mut cursor, "the tables table")?;
                    self.expect(&mut cursor, "(")?;
                    let record = self.name(&mut cursor, "the record column")?;
                    self.expect(&mut cursor, ",")?;
                    let name = self.name(&mut cursor, "the name column")?;
                    self.expect(&mut cursor, ")")?;
                    tables = Some(AuditTables { table, record, name });
                }
                let mut lists = Vec::new();
                while cursor.peek_is("exclude") || cursor.peek_is("include") {
                    let keyword = self.word(&mut cursor, |_| Class::Keyword, "'exclude' or 'include'")?;
                    let columns = self.audit_columns(&mut cursor)?;
                    lists.push(AuditList { keyword, columns });
                }
                if cursor.peek().is_some() {
                    let expected =
                        if tables.is_none() { "'tables', 'exclude', 'include' or the end of the line" } else { "'exclude', 'include' or the end of the line" };
                    self.syntax(&cursor, expected);
                    return None;
                }
                // Names in a list are checked only on first appearance. The audit column is rejected by a separate check.
                let mut named = HashSet::new();
                for listed in lists.iter().flat_map(|l| &l.columns) {
                    if named.insert(listed.text.clone()) && listed.text != column.text {
                        self.check_name(&listed.text, listed.pos);
                    }
                }
                Some(Setting::Audit { into, column, references, action, previous, tables, lists })
            })(),
            _ => {
                self.report(err(keyword.pos, "setting", format!("setting {} is unknown", go_quote(keyword.text))));
                return;
            }
        };
        let Some(setting) = setting else { return };
        if self.end(&cursor).is_none() {
            return;
        }
        let args = setting_words(&setting);
        let table = self.table_name();
        self.declarations.push(Declaration {
            kind: "setting",
            path: vec![table],
            pos: keyword.pos,
            setting: Some(SettingWords { keyword: keyword.text.to_owned(), args }),
        });
        if let Some(settings) = self.settings_target() {
            settings.lines.push(SettingLine { comments, pos: keyword.pos, setting });
        }
    }

    /// `store files`, `store document <shape>` or `store block <foreign key> <shape>`, each with an optional
    /// `shard <column> <period>`. The clause is read after `block` too: the validator rejects it there.
    fn store(&mut self, cursor: &mut Cursor) -> Option<Setting> {
        let kind = self.one_of(cursor, &["files", "document", "block"], "'files', 'document' or 'block'")?;
        let foreign = if kind.text == "block" { Some(self.name(cursor, "a foreign key name")?) } else { None };
        let shape = if kind.text == "files" { None } else { Some(self.one_of(cursor, &["list", "table"], "'list' or 'table'")?) };
        let shard = if cursor.peek_is("shard") {
            let keyword = self.word(cursor, |_| Class::Keyword, "'shard'")?;
            let column = self.name(cursor, "the shard column")?;
            let period = self.one_of(cursor, &["year", "month", "day"], "'year', 'month' or 'day'")?;
            Some(StoreShard { keyword, column, period })
        } else {
            None
        };
        Some(Setting::Store { kind, foreign, shape, shard })
    }

    /// A word that is one of `words`; the word is returned as a name.
    fn one_of(&mut self, cursor: &mut Cursor, words: &[&str], expected: &str) -> Option<Name> {
        match cursor.peek() {
            Some(t) if t.kind == Kind::Word && words.contains(&t.text) => {
                cursor.next();
                self.mark(t, Class::Keyword);
                Some(Name { text: t.text.to_owned(), pos: t.pos })
            }
            _ => {
                self.syntax(cursor, expected);
                None
            }
        }
    }

    fn diagram_line(&mut self, tokens: &[Token]) {
        if self.closing(tokens) {
            self.close_diagram();
            return;
        }
        let comments = self.comments();
        let mut cursor = Cursor::new(tokens);
        // The table name is checked once the line is a whole entry, as in Go: a line abandoned with a syntax diagnostic, such
        // as a diagram header inside an open diagram block, reports that diagnostic alone.
        let Some(table) = self.word(&mut cursor, |_| Class::Name, "a table name or '}'") else { return };
        if self.expect(&mut cursor, "at").is_none() {
            return;
        }
        // Go reads each coordinate as a value and checks it once the entry parsed: a coordinate that is not an integer
        // from -2147483648 to 2147483647 is reported at its token, its `-` for a negative one.
        let mut coordinates = [0i32; 2];
        let mut bad = Vec::new();
        for (index, coordinate) in coordinates.iter_mut().enumerate() {
            let expected = if index == 0 { "the x coordinate" } else { "the y coordinate" };
            let pos = cursor.here();
            let negative = cursor.peek_is("-");
            if negative {
                cursor.next();
                // Only the y coordinate takes a word after `-`; it is not an integer.
                let word = index == 1 && cursor.peek().is_some_and(|t| t.kind == Kind::Word);
                if !word && cursor.peek().is_none_or(|t| t.kind != Kind::Number) {
                    self.syntax(&cursor, "a number after '-'");
                    return;
                }
            }
            let Some(token) = cursor.peek().filter(|t| matches!(t.kind, Kind::Word | Kind::Number | Kind::Str)) else {
                self.syntax(&cursor, expected);
                return;
            };
            cursor.next();
            let value = if token.kind == Kind::Number && !token.text.contains('.') { coordinate_value(token.text, negative) } else { Err(()) };
            match value {
                Ok(value) => *coordinate = value,
                Err(()) => {
                    let shown = if token.kind == Kind::Str { token.describe() } else { format!("'{}{}'", if negative { "-" } else { "" }, token.text) };
                    bad.push(err(pos, "diagram", format!("coordinate {shown} is not an integer from -2147483648 to 2147483647")));
                }
            }
        }
        if self.end(&cursor).is_none() {
            return;
        }
        self.diags.extend(bad);
        self.check_name(&table.text, table.pos);
        let diagram_name = self.diagram.as_ref().map_or_else(String::new, |d| d.name.text.clone());
        self.declare("diagram_entry", vec![diagram_name, table.text.clone()], table.pos);
        if let Some(diagram) = self.diagram.as_mut() {
            diagram.placements.push(Placement { comments, table, x: coordinates[0], y: coordinates[1] });
        }
    }

    /// Reports a `syntax` error once at the `{` of the innermost open block (as in Go). An open settings block reports only its own `{`
    /// and does not report a table's `{`. A block whose header line failed already has an error.
    fn report_open_blocks(&mut self) {
        let open = match self.context {
            Context::Top => None,
            Context::Table => self.table_brace.map(|pos| (pos, "'{'")),
            Context::Settings => self.settings_brace.map(|pos| (pos, if self.settings_braced { "'{'" } else { "'settings'" })),
            Context::Diagram => self.diagram_brace.map(|pos| (pos, "'{'")),
        };
        if let Some((pos, shown)) = open {
            self.report(err(pos, "syntax", format!("block opened at this {shown} is not closed")));
        }
    }

    fn finish(&mut self) {
        self.report_open_blocks();
        match self.context {
            Context::Diagram => self.close_diagram(),
            Context::Table | Context::Settings => self.close_table(),
            Context::Top => {}
        }
        self.document.trailing = self.comments();
    }
}
