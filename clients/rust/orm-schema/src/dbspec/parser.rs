//! Reads dbspec text line by line into the model and reports the errors that a
//! single line shows. Cross references are checked by `validate`.

use super::check::{not_allowed, CheckParser};
use super::lexer::{tokenize, Kind, Token};
use super::literal::{default_literal, Value};
use super::model::*;

pub(crate) const MAX_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_TABLES: usize = 4096;
pub(crate) const MAX_COLUMNS: usize = 120_000;
pub(crate) const MAX_FOREIGN_KEYS: usize = 20_000;
pub(crate) const MAX_TABLE_COLUMNS: usize = 1000;
const MAX_NAME_BYTES: usize = 63;

/// Words that are not valid names.
const RESERVED: [&str; 15] =
    ["dbspec", "use", "table", "diagram", "primary", "unique", "index", "foreign", "check", "settings", "null", "identity", "default", "true", "false"];

/// A name that matches `[a-z][a-z0-9_]*`, is not reserved and has at most 63 bytes.
pub(crate) fn well_formed(text: &str) -> bool {
    name_format(text) && text.len() <= MAX_NAME_BYTES
}

/// The diagnostic of a malformed name, if any.
pub(crate) fn name_problem(text: &str) -> Option<(&'static str, String)> {
    if !name_format(text) {
        Some(("name.format", format!("name '{text}' does not match [a-z][a-z0-9_]* or is a reserved word")))
    } else if text.len() > MAX_NAME_BYTES {
        Some(("name.length", format!("name '{text}' has {} bytes; the limit is {MAX_NAME_BYTES}", text.len())))
    } else {
        None
    }
}

fn name_format(text: &str) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
        && !RESERVED.contains(&text)
}

pub(crate) const CODEC_STAGES: [&str; 8] = ["ordered_json", "aes", "hex", "gz", "base64", "serialize", "yaml", "ip"];

#[derive(Clone, Debug)]
pub(crate) struct Diag {
    pub pos: Pos,
    pub rule: &'static str,
    pub message: String,
}

/// The parsed document with the line errors, and for each table the names of
/// columns whose lines failed, so references to them report nothing more.
pub(crate) struct Parsed {
    pub document: Document,
    pub unresolved: Vec<Vec<String>>,
    /// For each table, the key and index lines that failed.
    pub failed_keys: Vec<FailedKeys>,
    pub diags: Vec<Diag>,
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
pub(crate) type Stopped = Vec<Diag>;

struct Cursor<'t, 'a> {
    tokens: &'t [Token<'a>],
    at: usize,
    end: Pos,
}

impl<'t, 'a> Cursor<'t, 'a> {
    fn new(tokens: &'t [Token<'a>]) -> Self {
        let end = tokens.last().map_or(Pos::default(), |t| t.end());
        Self { tokens, at: 0, end }
    }

    fn peek(&self) -> Option<&'t Token<'a>> {
        self.tokens.get(self.at)
    }

    fn peek_is(&self, text: &str) -> bool {
        self.peek().is_some_and(|t| t.is(text))
    }

    fn next(&mut self) -> Option<&'t Token<'a>> {
        let token = self.tokens.get(self.at);
        self.at += 1;
        token
    }

    fn here(&self) -> Pos {
        self.peek().map_or(self.end, |t| t.pos)
    }
}

enum Context {
    Top,
    Table,
    Settings,
    Diagram,
}

struct Parser {
    diags: Vec<Diag>,
    pending: Vec<String>,
    document: Document,
    unresolved: Vec<Vec<String>>,
    failed_keys: Vec<FailedKeys>,
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
    diagram_brace: Option<Pos>,
    diagram: Option<Diagram>,
    columns: usize,
    foreign_keys: usize,
    stopped: bool,
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
        return Err(err(start, "limit", format!("document has {} bytes; the limit is {MAX_BYTES}", text.len())));
    }
    if text.starts_with('\u{feff}') {
        return Err(err(start, "encoding", "document starts with a byte order mark"));
    }
    let mut lines = Vec::new();
    for raw in text.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let cr = line.find('\r').map(|cr| line[..cr].chars().count() + 1);
        lines.push((line, cr));
    }
    if text.ends_with('\n') {
        lines.pop();
    }
    Ok(lines)
}

pub(crate) fn parse(text: &str) -> Result<Parsed, Stopped> {
    let lines = lines(text).map_err(|d| vec![d])?;
    if let Some((_, Some(column))) = lines.first() {
        return Err(vec![bare_cr(1, *column)]);
    }
    let header_tokens = lines.first().map(|(l, _)| tokenize(l, 1)).unwrap_or_default();
    let name = header(lines.first().map_or("", |(l, _)| l), &header_tokens).map_err(|d| vec![d])?;
    let mut parser = Parser {
        diags: Vec::new(),
        pending: Vec::new(),
        document: Document {
            name: Name { text: String::new(), pos: Pos::default() },
            uses: Vec::new(),
            tables: Vec::new(),
            diagrams: Vec::new(),
            trailing: Vec::new(),
        },
        unresolved: Vec::new(),
        failed_keys: Vec::new(),
        context: Context::Top,
        skip: 0,
        phase: 0,
        table: None,
        table_unresolved: Vec::new(),
        table_failed_keys: FailedKeys::default(),
        table_phase: 0,
        table_brace: None,
        settings_brace: None,
        diagram_brace: None,
        diagram: None,
        columns: 0,
        foreign_keys: 0,
        stopped: false,
    };
    parser.document.name = parser.define(name);
    for (index, (line, cr)) in lines.iter().enumerate().skip(1) {
        if let Some(column) = cr {
            parser.report(bare_cr(index + 1, *column));
            return Err(parser.diags);
        }
        parser.line(line, index + 1);
        if parser.stopped {
            return Err(parser.diags);
        }
    }
    parser.finish();
    Ok(Parsed { document: parser.document, unresolved: parser.unresolved, failed_keys: parser.failed_keys, diags: parser.diags })
}

fn bare_cr(line: usize, column: usize) -> Diag {
    err(Pos { line, column }, "encoding", "a bare CR is not a line end")
}

/// The header is exactly `dbspec`, a space, `1`, a space and the document
/// name; returns the name token. An error points at the first character that
/// departs from that form.
fn header<'t, 'a>(line: &'a str, tokens: &'t [Token<'a>]) -> Result<&'t Token<'a>, Diag> {
    const PREFIX: &str = "dbspec 1 ";
    let at = |column: usize, message: &str| err(Pos { line: 1, column }, "header", message);
    for (index, expected) in PREFIX.chars().enumerate() {
        match line.chars().nth(index) {
            Some(c) if c == expected => {}
            _ if index == 7 && line.starts_with("dbspec ") => return Err(at(index + 1, "the language version is not 1")),
            _ => return Err(at(index + 1, "the first line is not 'dbspec 1 <document>'")),
        }
    }
    match tokens.get(2) {
        Some(name) if matches!(name.kind, Kind::Word | Kind::Number) && name.pos.column == PREFIX.len() + 1 => {
            let end = name.end().column;
            if line.chars().count() + 1 == end {
                Ok(name)
            } else {
                Err(at(end, "the header has text after the document name"))
            }
        }
        _ => Err(at(PREFIX.len() + 1, "the header has no document name")),
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

fn line_kind(first: &Token, second: Option<&Token>) -> Option<LineKind> {
    match first.text {
        "primary" => Some(LineKind::Primary),
        "unique" => Some(LineKind::Unique),
        "index" => Some(LineKind::Index),
        "foreign" => Some(LineKind::ForeignKey),
        "check" => Some(LineKind::Check),
        "settings" if second.is_some_and(|t| t.is("{")) => Some(LineKind::Settings),
        _ => None,
    }
}

impl Parser {
    fn report(&mut self, diag: Diag) {
        self.diags.push(diag);
    }

    fn syntax(&mut self, cursor: &Cursor) {
        let diag = match cursor.peek() {
            Some(t) => err(t.pos, "syntax", format!("'{}' is not allowed here", t.text)),
            None => err(cursor.end, "syntax", "the line ends early"),
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

    /// Checks a name, defined or referenced, and returns it.
    fn define(&mut self, token: &Token) -> Name {
        self.check_name(token.text, token.pos);
        Name { text: token.text.to_owned(), pos: token.pos }
    }

    fn check_name(&mut self, text: &str, pos: Pos) {
        if let Some((rule, message)) = name_problem(text) {
            self.report(err(pos, rule, message));
        }
    }

    /// Reads a name token and checks it. A malformed reference is reported
    /// here and not resolved further.
    fn name(&mut self, cursor: &mut Cursor) -> Option<Name> {
        match cursor.peek() {
            Some(t) if matches!(t.kind, Kind::Word | Kind::Number) => {
                cursor.next();
                Some(self.define(t))
            }
            _ => {
                self.syntax(cursor);
                None
            }
        }
    }

    /// Reads a word that is not a name, such as a codec stage.
    fn word(&mut self, cursor: &mut Cursor) -> Option<Name> {
        match cursor.peek() {
            Some(t) if matches!(t.kind, Kind::Word | Kind::Number) => {
                cursor.next();
                Some(Name { text: t.text.to_owned(), pos: t.pos })
            }
            _ => {
                self.syntax(cursor);
                None
            }
        }
    }

    fn expect(&mut self, cursor: &mut Cursor, text: &str) -> Option<()> {
        if cursor.peek_is(text) {
            cursor.next();
            Some(())
        } else {
            self.syntax(cursor);
            None
        }
    }

    fn end(&mut self, cursor: &Cursor) -> Option<()> {
        if cursor.peek().is_some() {
            self.syntax(cursor);
            None
        } else {
            Some(())
        }
    }

    fn line(&mut self, line: &str, number: usize) {
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
        let tokens = tokenize(line, number);
        if self.skip > 0 {
            if tokens.len() == 1 && tokens[0].is("}") {
                self.skip -= 1;
            } else if tokens.last().is_some_and(|t| t.is("{")) {
                self.skip += 1;
            }
            return;
        }
        let first = &tokens[0];
        let check_line = matches!(self.context, Context::Table) && first.is("check");
        if !check_line {
            if let Some(bad) = tokens.iter().find(|t| t.kind == Kind::Invalid) {
                self.report(err(bad.pos, "syntax", format!("'{}' is not allowed here", bad.text)));
                // The line keeps the kind and name that its words give.
                let mut words = tokens.iter().filter(|t| t.kind != Kind::Invalid);
                if let (Context::Table, Some(word)) = (&self.context, words.next()) {
                    match line_kind(word, words.next()) {
                        Some(LineKind::Primary) => self.fail_key(true),
                        Some(LineKind::Unique | LineKind::Index) => self.fail_key(false),
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
        }
        match self.context {
            Context::Top => self.top_line(&tokens),
            Context::Table => self.table_line(&tokens),
            Context::Settings => self.setting_line(&tokens),
            Context::Diagram => self.diagram_line(&tokens),
        }
    }

    fn top_line(&mut self, tokens: &[Token]) {
        let first = &tokens[0];
        let mut cursor = Cursor::new(tokens);
        match first.text {
            "use" if first.kind == Kind::Word => {
                if self.phase > 0 {
                    self.report(err(first.pos, "order", "'use' comes before tables and diagrams"));
                }
                self.use_line(&mut cursor);
            }
            "table" if first.kind == Kind::Word => {
                if self.phase > 1 {
                    self.report(err(first.pos, "order", "tables come before diagrams"));
                }
                self.phase = self.phase.max(1);
                self.open_table(&mut cursor);
            }
            "diagram" if first.kind == Kind::Word => {
                self.phase = 2;
                self.open_diagram(&mut cursor);
            }
            _ => {
                self.syntax(&cursor);
                if tokens.len() > 1 && tokens.last().is_some_and(|t| t.is("{")) {
                    self.skip = 1;
                }
            }
        }
    }

    fn use_line(&mut self, cursor: &mut Cursor) {
        cursor.next();
        let comments = self.comments();
        let Some(document) = self.name(cursor) else { return };
        if self.expect(cursor, "{").is_none() {
            return;
        }
        let mut tables = Vec::new();
        loop {
            let Some(table) = self.name(cursor) else { return };
            tables.push(table);
            if cursor.peek_is(",") {
                cursor.next();
                continue;
            }
            if self.expect(cursor, "}").is_none() || self.end(cursor).is_none() {
                return;
            }
            break;
        }
        self.document.uses.push(Use { comments, document, tables });
    }

    /// `<name> {` after `table` or `diagram`. The block opens even when the
    /// line is malformed, so its lines are still read.
    fn block_header(&mut self, cursor: &mut Cursor, keyword: Pos) -> (Name, Option<Pos>) {
        match self.name(cursor) {
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
        let keyword = cursor.next().map_or(Pos::default(), |t| t.pos);
        if self.document.tables.len() >= MAX_TABLES {
            self.stop(keyword, format!("document has more than {MAX_TABLES} tables"));
            return;
        }
        let comments = self.comments();
        let (name, brace) = self.block_header(cursor, keyword);
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
        self.table_phase = 0;
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
            self.failed_keys.push(std::mem::take(&mut self.table_failed_keys));
        }
        self.context = Context::Top;
    }

    fn open_diagram(&mut self, cursor: &mut Cursor) {
        let keyword = cursor.next().map_or(Pos::default(), |t| t.pos);
        let comments = self.comments();
        let (name, brace) = self.block_header(cursor, keyword);
        self.diagram_brace = brace;
        self.diagram = Some(Diagram { comments, name, placements: Vec::new(), closing: Vec::new() });
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
        if tokens.len() > 1 {
            self.report(err(tokens[1].pos, "syntax", format!("'{}' is not allowed after '}}'", tokens[1].text)));
        }
        true
    }

    /// A `table` or `diagram` line inside a block: the block lacks its `}`.
    fn unclosed(&mut self, tokens: &[Token]) -> bool {
        let opens = (tokens[0].is("table") || tokens[0].is("diagram")) && tokens.len() > 1 && tokens.last().is_some_and(|t| t.is("{"));
        if opens {
            self.report_open_blocks();
            match self.context {
                Context::Diagram => self.close_diagram(),
                _ => self.close_table(),
            }
            self.top_line(tokens);
        }
        opens
    }

    fn table_line(&mut self, tokens: &[Token]) {
        if self.closing(tokens) {
            self.close_table();
            return;
        }
        if self.unclosed(tokens) {
            return;
        }
        let first = &tokens[0];
        let kind = if first.kind == Kind::Word { line_kind(first, tokens.get(1)) } else { None };
        let phase = match kind {
            None => 0,
            Some(LineKind::Settings) => 2,
            Some(_) => 1,
        };
        let second_settings = kind == Some(LineKind::Settings) && self.table.as_ref().is_some_and(|t| t.settings.is_some());
        if phase < self.table_phase || second_settings {
            let message = if second_settings {
                "a table has at most one settings block"
            } else {
                "table lines are columns, then key, index, foreign key and check lines, then settings"
            };
            self.report(err(first.pos, "order", message));
        } else {
            self.table_phase = phase;
        }
        let mut cursor = Cursor::new(tokens);
        match kind {
            Some(LineKind::Primary) => self.primary_line(&mut cursor),
            Some(LineKind::Unique) => self.unique_line(&mut cursor),
            Some(LineKind::Index) => self.index_line(&mut cursor),
            Some(LineKind::ForeignKey) => self.foreign_key_line(&mut cursor),
            Some(LineKind::Check) => self.check_line(&mut cursor),
            Some(LineKind::Settings) => self.open_settings(first, tokens.get(1).map(|t| t.pos), tokens.get(2)),
            None => self.column_line(&mut cursor),
        }
    }

    fn table_mut(&mut self) -> &mut Table {
        self.table.as_mut().expect("a table line is read inside a table")
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
            Some(column) => self.table_mut().columns.push(column),
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
        let name = self.name(cursor)?;
        let ty = self.column_type(cursor)?;
        let nullable = cursor.peek_is("null");
        if nullable {
            cursor.next();
        }
        let identity = cursor.peek_is("identity").then(|| cursor.next().map(|t| t.pos)).flatten();
        let mut default = None;
        let mut default_keyword = None;
        if cursor.peek_is("default") {
            default_keyword = cursor.next().map(|t| t.pos);
            let value_pos = cursor.here();
            let value = match cursor.next() {
                Some(t) if t.is("-") => match cursor.next() {
                    Some(n) if n.kind == Kind::Number => Some(Value::Number { negative: true, text: n.text.to_owned() }),
                    _ => None,
                },
                Some(t) if t.kind == Kind::Number => Some(Value::Number { negative: false, text: t.text.to_owned() }),
                Some(t) if t.kind == Kind::Word => Some(Value::Word(t.text.to_owned())),
                Some(t) if t.kind == Kind::Str => Some(Value::Str(t.string_value())),
                Some(_) => None,
                None => {
                    self.report(err(cursor.end, "syntax", "'default' has no value"));
                    return None;
                }
            };
            default = Some((value_pos, value));
        }
        self.end(cursor)?;
        if let Some(pos) = identity {
            let mut problems = Vec::new();
            if nullable {
                problems.push("cannot be null");
            }
            if ty.is_some_and(|t| t != Type::I64) {
                problems.push("must be i64");
            }
            if !problems.is_empty() {
                self.report(err(pos, "column", format!("identity column {}", problems.join(" and "))));
            }
            if let Some(keyword) = default_keyword {
                self.report(err(keyword, "column", "an identity column has no default"));
            }
        }
        let ty = ty?;
        let default = match (default, default_keyword) {
            (Some(_), Some(keyword)) if matches!(ty, Type::Text | Type::Bytes) => {
                self.report(err(keyword, "column", format!("a {} column has no default", ty.render())));
                None
            }
            (Some((pos, value)), Some(_)) if identity.is_none() => {
                let checked = match &value {
                    Some(value) => default_literal(ty, value),
                    None => Err("default is not a literal".into()),
                };
                match checked {
                    Ok(text) if text == "now" => Some(DefaultValue::Now),
                    Ok(text) => Some(DefaultValue::Literal(text)),
                    Err(message) => {
                        self.report(err(pos, "column", message));
                        None
                    }
                }
            }
            _ => None,
        };
        Some(Column { comments, name, ty, nullable, identity, default })
    }

    /// Reads a type with its parameters. The outer `None` abandons the line; the
    /// inner `None` is a type error that was reported.
    fn column_type(&mut self, cursor: &mut Cursor) -> Option<Option<Type>> {
        let Some(word) = cursor.peek() else {
            self.syntax(cursor);
            return None;
        };
        cursor.next();
        let mut params: Option<Vec<Option<u32>>> = None;
        let mut malformed = false;
        if cursor.peek_is("(") {
            cursor.next();
            let mut values = Vec::new();
            loop {
                match cursor.next() {
                    Some(t) if t.kind == Kind::Number && !t.text.contains('.') => values.push(t.text.parse::<u32>().ok()),
                    _ => {
                        malformed = true;
                        break;
                    }
                }
                match cursor.next() {
                    Some(t) if t.is(",") => continue,
                    Some(t) if t.is(")") => break,
                    _ => {
                        malformed = true;
                        break;
                    }
                }
            }
            if malformed {
                while let Some(t) = cursor.next() {
                    if t.is(")") {
                        break;
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
            let known = ["i16", "i32", "i64", "bool", "f64", "text", "bytes", "uuid", "date", "decimal", "varchar", "time", "datetime"];
            let message = if word.kind == Kind::Word && known.contains(&word.text) {
                format!("type '{}' has parameters out of range", word.text)
            } else {
                format!("unknown type '{}'", word.text)
            };
            self.report(err(word.pos, "type", message));
        }
        Some(ty)
    }

    /// `( <column> [asc|desc], ... )`; directions only when `directions` is set.
    fn column_list(&mut self, cursor: &mut Cursor, directions: bool) -> Option<Vec<(Name, bool)>> {
        self.expect(cursor, "(")?;
        let mut columns = Vec::new();
        loop {
            let name = self.name(cursor)?;
            let mut desc = false;
            if directions && (cursor.peek_is("asc") || cursor.peek_is("desc")) {
                desc = cursor.next().is_some_and(|t| t.text == "desc");
            }
            columns.push((name, desc));
            if cursor.peek_is(",") {
                cursor.next();
                continue;
            }
            self.expect(cursor, ")")?;
            return Some(columns);
        }
    }

    /// Knows a key or index line that failed, so the rules that depend on its columns report nothing.
    fn fail_key(&mut self, primary: bool) {
        self.table_failed_keys.primary |= primary;
        self.table_failed_keys.any = true;
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
        let name = self.name(cursor)?;
        let columns = self.column_list(cursor, false)?;
        self.end(cursor)?;
        let columns = columns.into_iter().map(|(n, _)| n).collect();
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
        let name = self.name(cursor)?;
        let columns = self.column_list(cursor, true)?;
        self.end(cursor)?;
        self.table_mut().indexes.push(Index { comments, name, columns });
        Some(())
    }

    fn action(&mut self, cursor: &mut Cursor) -> Option<Action> {
        let action = match cursor.peek().map(|t| (t.kind, t.text)) {
            Some((Kind::Word, "restrict")) => Action::Restrict,
            Some((Kind::Word, "cascade")) => Action::Cascade,
            Some((Kind::Word, "set_null")) => Action::SetNull,
            _ => {
                self.syntax(cursor);
                return None;
            }
        };
        cursor.next();
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
        let Some(name) = self.name(cursor) else { return };
        let Some(columns) = self.column_list(cursor, false) else { return };
        if self.expect(cursor, "references").is_none() {
            return;
        }
        let Some(table) = self.name(cursor) else { return };
        let Some(references) = self.column_list(cursor, false) else { return };
        let mut on_delete = Action::Restrict;
        let mut on_update = Action::Restrict;
        if cursor.peek_is("on") && cursor.tokens.get(cursor.at + 1).is_some_and(|t| t.is("delete")) {
            cursor.at += 2;
            let Some(action) = self.action(cursor) else { return };
            on_delete = action;
        }
        if cursor.peek_is("on") && cursor.tokens.get(cursor.at + 1).is_some_and(|t| t.is("update")) {
            cursor.at += 2;
            let Some(action) = self.action(cursor) else { return };
            on_update = action;
        }
        if self.end(cursor).is_none() {
            return;
        }
        let columns = columns.into_iter().map(|(n, _)| n).collect();
        let references = references.into_iter().map(|(n, _)| n).collect();
        self.table_mut().foreign_keys.push(ForeignKey { comments, name, columns, table, references, on_delete, on_update });
    }

    fn check_line(&mut self, cursor: &mut Cursor) {
        let comments = self.comments();
        cursor.next();
        let Some(name) = self.name(cursor) else { return };
        if let Some(bad) = cursor.tokens[..cursor.at].iter().find(|t| t.kind == Kind::Invalid) {
            self.report(err(bad.pos, "syntax", format!("'{}' is not allowed here", bad.text)));
            return;
        }
        if self.expect(cursor, "(").is_none() {
            return;
        }
        let rest = &cursor.tokens[cursor.at..];
        let mut parser = CheckParser::new(rest, cursor.end);
        let result = parser.expression().and_then(|expr| {
            let at = parser.position();
            match rest.get(at) {
                Some(t) if t.is(")") && at + 1 == rest.len() => Ok(expr),
                Some(t) if t.is(")") => Err((rest[at + 1].pos, format!("'{}' is not allowed after the check expression", rest[at + 1].text))),
                Some(t) => Err(not_allowed(t)),
                None => Err((cursor.end, "check expression has no closing ')'".into())),
            }
        });
        match result {
            Ok(expr) => self.table_mut().checks.push(Check { comments, name, expr }),
            Err((pos, message)) => self.report(err(pos, "check", message)),
        }
    }

    /// `settings {`; a second block was reported as `order` and its lines join the first.
    fn open_settings(&mut self, _keyword: &Token, brace: Option<Pos>, extra: Option<&Token>) {
        let comments = self.comments();
        self.settings_brace = brace;
        if let Some(extra) = extra {
            self.report(err(extra.pos, "syntax", format!("'{}' is not allowed after '{{'", extra.text)));
            self.settings_brace = None;
        }
        if self.table_mut().settings.is_none() {
            self.table_mut().settings = Some(Settings { comments, lines: Vec::new(), closing: Vec::new() });
        }
        self.context = Context::Settings;
    }

    fn setting_line(&mut self, tokens: &[Token]) {
        if self.closing(tokens) {
            let closing = self.comments();
            if let Some(settings) = self.table_mut().settings.as_mut() {
                settings.closing = closing;
            }
            self.context = Context::Table;
            return;
        }
        if self.unclosed(tokens) {
            return;
        }
        let mut cursor = Cursor::new(tokens);
        let comments = self.comments();
        let keyword = tokens[0];
        cursor.next();
        let setting = match (keyword.kind, keyword.text) {
            (Kind::Word, "entity") => self.name(&mut cursor).map(Setting::Entity),
            (Kind::Word, "updated") => self.name(&mut cursor).map(Setting::Updated),
            (Kind::Word, "soft_delete") => self.name(&mut cursor).map(Setting::SoftDelete),
            (Kind::Word, "aes_version") => self.name(&mut cursor).map(Setting::AesVersion),
            (Kind::Word, "select") => self.expect(&mut cursor, "explicit").and_then(|_| {
                let mut columns = vec![self.name(&mut cursor)?];
                while cursor.peek().is_some() {
                    columns.push(self.name(&mut cursor)?);
                }
                Some(Setting::SelectExplicit(columns))
            }),
            (Kind::Word, "codec") => self.name(&mut cursor).and_then(|column| {
                let mut stages = vec![self.word(&mut cursor)?];
                while cursor.peek().is_some() {
                    stages.push(self.word(&mut cursor)?);
                }
                for (index, stage) in stages.iter().enumerate() {
                    if !CODEC_STAGES.contains(&stage.text.as_str()) {
                        self.report(err(stage.pos, "setting", format!("unknown codec stage '{}'", stage.text)));
                    } else if stage.text == "ordered_json" && index > 0 {
                        self.report(err(stage.pos, "setting", "ordered_json is the first codec stage"));
                    }
                }
                Some(Setting::Codec(column, stages))
            }),
            (Kind::Word, "blind_index") => self.name(&mut cursor).and_then(|aes| Some(Setting::BlindIndex(aes, self.name(&mut cursor)?))),
            (Kind::Word, "navigation") => self.name(&mut cursor).and_then(|key| {
                let child = self.name(&mut cursor)?;
                let parent = self.name(&mut cursor)?;
                Some(Setting::Navigation(key, child, parent))
            }),
            (Kind::Word, "immutable") => Some(Setting::Immutable),
            (Kind::Word, "audit") => (|| {
                self.expect(&mut cursor, "into")?;
                let into = self.name(&mut cursor)?;
                self.expect(&mut cursor, "operation")?;
                let operation = self.name(&mut cursor)?;
                self.expect(&mut cursor, "action")?;
                let action = self.name(&mut cursor)?;
                self.expect(&mut cursor, "previous")?;
                let previous = self.name(&mut cursor)?;
                Some(Setting::Audit { into, operation, action, previous })
            })(),
            _ => {
                self.report(err(keyword.pos, "setting", format!("unknown setting '{}'", keyword.text)));
                return;
            }
        };
        let Some(setting) = setting else { return };
        if self.end(&cursor).is_none() {
            return;
        }
        if let Some(settings) = self.table_mut().settings.as_mut() {
            settings.lines.push(SettingLine { comments, pos: keyword.pos, setting });
        }
    }

    fn diagram_line(&mut self, tokens: &[Token]) {
        if self.closing(tokens) {
            self.close_diagram();
            return;
        }
        if self.unclosed(tokens) {
            return;
        }
        let comments = self.comments();
        let mut cursor = Cursor::new(tokens);
        let Some(table) = self.name(&mut cursor) else { return };
        if self.expect(&mut cursor, "at").is_none() {
            return;
        }
        let mut coordinates = [0i32; 2];
        for coordinate in &mut coordinates {
            let pos = cursor.here();
            let negative = cursor.peek_is("-");
            if negative {
                cursor.next();
            }
            let value = match cursor.next() {
                Some(t) if t.kind == Kind::Number && !t.text.contains('.') => {
                    let digits = t.text.trim_start_matches('0');
                    let magnitude = if digits.is_empty() {
                        Some(0)
                    } else if digits.len() > 20 {
                        None
                    } else {
                        digits.parse::<i128>().ok()
                    };
                    magnitude.and_then(|m| i32::try_from(if negative { -m } else { m }).ok())
                }
                None => {
                    self.report(err(cursor.end, "syntax", "the line ends early"));
                    return;
                }
                Some(_) => None,
            };
            match value {
                Some(value) => *coordinate = value,
                None => {
                    self.report(err(pos, "diagram", "a coordinate is not an integer"));
                    return;
                }
            }
        }
        if self.end(&cursor).is_none() {
            return;
        }
        if let Some(diagram) = self.diagram.as_mut() {
            diagram.placements.push(Placement { comments, table, x: coordinates[0], y: coordinates[1] });
        }
    }

    /// Reports a `syntax` error at the `{` of every open block. A block whose
    /// header line failed already has its error.
    fn report_open_blocks(&mut self) {
        let braces = match self.context {
            Context::Top => vec![],
            Context::Table => vec![self.table_brace],
            Context::Settings => vec![self.table_brace, self.settings_brace],
            Context::Diagram => vec![self.diagram_brace],
        };
        for brace in braces.into_iter().flatten() {
            self.report(err(brace, "syntax", "the block has no closing '}'"));
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
