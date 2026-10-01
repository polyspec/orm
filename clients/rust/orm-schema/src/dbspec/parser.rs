//! Reads dbspec text line by line into the model and reports the errors that a
//! single line shows. Cross references are checked by `validate`.

use super::check::CheckParser;
use super::lexer::{tokenize, Kind, Token};
use super::literal::{default_literal, Value};
use super::model::*;

pub(crate) const MAX_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_TABLES: usize = 4096;
pub(crate) const MAX_COLUMNS: usize = 120_000;
pub(crate) const MAX_FOREIGN_KEYS: usize = 20_000;
pub(crate) const MAX_TABLE_COLUMNS: usize = 1000;
const MAX_NAME_BYTES: usize = 63;

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
    pub diags: Vec<Diag>,
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
    context: Context,
    /// Depth of an unreadable block whose lines are skipped.
    skip: usize,
    /// Top-level phase: 0 `use`, 1 `table`, 2 `diagram`.
    phase: u8,
    table: Option<Table>,
    table_unresolved: Vec<String>,
    /// Table line phase: 0 columns, 1 keys, 2 indexes, 3 foreign keys, 4 checks, 5 settings.
    table_phase: u8,
    diagram: Option<Diagram>,
    columns: usize,
    foreign_keys: usize,
    stopped: bool,
}

fn err(pos: Pos, rule: &'static str, message: impl Into<String>) -> Diag {
    Diag { pos, rule, message: message.into() }
}

/// Splits text into lines after the encoding checks: no byte order mark, no
/// bare CR, at most 32 MiB.
fn lines(text: &str) -> Result<Vec<&str>, Diag> {
    let start = Pos { line: 1, column: 1 };
    if text.len() > MAX_BYTES {
        return Err(err(start, "limit", format!("document has {} bytes; the limit is {MAX_BYTES}", text.len())));
    }
    if text.starts_with('\u{feff}') {
        return Err(err(start, "encoding", "document starts with a byte order mark"));
    }
    let mut lines = Vec::new();
    for (index, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(cr) = line.find('\r') {
            let column = line[..cr].chars().count() + 1;
            return Err(err(Pos { line: index + 1, column }, "encoding", "bare CR is not a line end"));
        }
        lines.push(line);
    }
    if text.ends_with('\n') {
        lines.pop();
    }
    Ok(lines)
}

pub(crate) fn parse(text: &str) -> Result<Parsed, Stopped> {
    let lines = lines(text).map_err(|d| vec![d])?;
    let header_tokens = lines.first().map(|l| tokenize(l, 1)).unwrap_or_default();
    let name = header(&header_tokens).map_err(|d| vec![d])?;
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
        context: Context::Top,
        skip: 0,
        phase: 0,
        table: None,
        table_unresolved: Vec::new(),
        table_phase: 0,
        diagram: None,
        columns: 0,
        foreign_keys: 0,
        stopped: false,
    };
    parser.document.name = parser.define(name);
    for (index, line) in lines.iter().enumerate().skip(1) {
        parser.line(line, index + 1);
        if parser.stopped {
            return Err(parser.diags);
        }
    }
    parser.finish(lines.len());
    Ok(Parsed { document: parser.document, unresolved: parser.unresolved, diags: parser.diags })
}

/// `dbspec 1 <document>`; returns the document name token.
fn header<'t, 'a>(tokens: &'t [Token<'a>]) -> Result<&'t Token<'a>, Diag> {
    let mut cursor = Cursor::new(tokens);
    let start = Pos { line: 1, column: 1 };
    let fail = |cursor: &Cursor, message: &str| err(if cursor.tokens.is_empty() { start } else { cursor.here() }, "header", message);
    if !cursor.peek_is("dbspec") {
        return Err(fail(&cursor, "the first line is not 'dbspec 1 <document>'"));
    }
    cursor.next();
    if !cursor.peek().is_some_and(|t| t.kind == Kind::Number && t.text == "1") {
        return Err(fail(&cursor, "the language version is not 1"));
    }
    cursor.next();
    let name = match cursor.peek() {
        Some(t) if matches!(t.kind, Kind::Word | Kind::Number) => t,
        _ => return Err(fail(&cursor, "the header has no document name")),
    };
    cursor.next();
    if cursor.peek().is_some() {
        return Err(fail(&cursor, "the header has a token after the document name"));
    }
    Ok(name)
}

fn line_kind(first: &Token, second: Option<&Token>) -> Option<u8> {
    match first.text {
        "primary" | "unique" => Some(1),
        "index" => Some(2),
        "foreign" => Some(3),
        "check" => Some(4),
        "settings" if second.is_some_and(|t| t.is("{")) => Some(5),
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

    /// Checks a defined name and returns it.
    fn define(&mut self, token: &Token) -> Name {
        let text = token.text;
        let bytes = text.as_bytes();
        let format = !bytes.is_empty() && bytes[0].is_ascii_lowercase() && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_');
        if !format || text == "primary" {
            self.report(err(token.pos, "name.format", format!("name '{text}' does not match [a-z][a-z0-9_]* or is 'primary'")));
        } else if text.len() > MAX_NAME_BYTES {
            self.report(err(token.pos, "name.length", format!("name '{text}' has {} bytes; the limit is {MAX_NAME_BYTES}", text.len())));
        }
        Name { text: text.to_owned(), pos: token.pos }
    }

    /// Reads a name token, defining it when `define` is set.
    fn name(&mut self, cursor: &mut Cursor, define: bool) -> Option<Name> {
        match cursor.peek() {
            Some(t) if matches!(t.kind, Kind::Word | Kind::Number) => {
                cursor.next();
                Some(if define { self.define(t) } else { Name { text: t.text.to_owned(), pos: t.pos } })
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
                if matches!(self.context, Context::Table) && first.kind == Kind::Word && line_kind(first, tokens.get(1)).is_none() {
                    self.table_unresolved.push(first.text.to_owned());
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
        let Some(document) = self.name(cursor, false) else { return };
        if self.expect(cursor, "{").is_none() {
            return;
        }
        let mut tables = Vec::new();
        loop {
            let Some(table) = self.name(cursor, false) else { return };
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
    fn block_header(&mut self, cursor: &mut Cursor, keyword: Pos) -> Name {
        match self.name(cursor, true) {
            Some(name) => {
                if self.expect(cursor, "{").is_some() {
                    self.end(cursor);
                }
                name
            }
            None => Name { text: String::new(), pos: keyword },
        }
    }

    fn open_table(&mut self, cursor: &mut Cursor) {
        let keyword = cursor.next().map_or(Pos::default(), |t| t.pos);
        if self.document.tables.len() >= MAX_TABLES {
            self.stop(keyword, format!("document has more than {MAX_TABLES} tables"));
            return;
        }
        let comments = self.comments();
        let name = self.block_header(cursor, keyword);
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
        }
        self.context = Context::Top;
    }

    fn open_diagram(&mut self, cursor: &mut Cursor) {
        let keyword = cursor.next().map_or(Pos::default(), |t| t.pos);
        let comments = self.comments();
        let name = self.block_header(cursor, keyword);
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
            self.report(err(tokens[0].pos, "syntax", "the block before this line has no closing '}'"));
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
        let phase = kind.unwrap_or(0);
        if phase < self.table_phase {
            self.report(err(first.pos, "order", "table lines are columns, keys, indexes, foreign keys, checks, then settings"));
        } else {
            self.table_phase = phase;
        }
        let mut cursor = Cursor::new(tokens);
        match (kind, first.text) {
            (Some(1), "primary") => self.primary_line(&mut cursor),
            (Some(1), _) => self.unique_line(&mut cursor),
            (Some(2), _) => self.index_line(&mut cursor),
            (Some(3), _) => self.foreign_key_line(&mut cursor),
            (Some(4), _) => self.check_line(&mut cursor),
            (Some(5), _) => self.open_settings(first),
            _ => self.column_line(&mut cursor),
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
        let name = self.name(cursor, true)?;
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
                    Some(n) if n.kind == Kind::Number => Some(Value::Number { negative: true, text: n.text }),
                    _ => None,
                },
                Some(t) if t.kind == Kind::Number => Some(Value::Number { negative: false, text: t.text }),
                Some(t) if t.kind == Kind::Word => Some(Value::Word(t.text)),
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
            let name = self.name(cursor, false)?;
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

    fn primary_line(&mut self, cursor: &mut Cursor) {
        let comments = self.comments();
        let pos = cursor.next().map_or(Pos::default(), |t| t.pos);
        if self.expect(cursor, "key").is_none() {
            return;
        }
        let Some(columns) = self.column_list(cursor, false) else { return };
        if self.end(cursor).is_none() {
            return;
        }
        let columns = columns.into_iter().map(|(n, _)| n).collect();
        self.table_mut().primary.push(PrimaryKey { comments, pos, columns });
    }

    fn unique_line(&mut self, cursor: &mut Cursor) {
        let comments = self.comments();
        cursor.next();
        let Some(name) = self.name(cursor, true) else { return };
        let Some(columns) = self.column_list(cursor, false) else { return };
        if self.end(cursor).is_none() {
            return;
        }
        let columns = columns.into_iter().map(|(n, _)| n).collect();
        self.table_mut().uniques.push(Unique { comments, name, columns });
    }

    fn index_line(&mut self, cursor: &mut Cursor) {
        let comments = self.comments();
        cursor.next();
        let Some(name) = self.name(cursor, true) else { return };
        let Some(columns) = self.column_list(cursor, true) else { return };
        if self.end(cursor).is_none() {
            return;
        }
        self.table_mut().indexes.push(Index { comments, name, columns });
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
        let Some(name) = self.name(cursor, true) else { return };
        let Some(columns) = self.column_list(cursor, false) else { return };
        if self.expect(cursor, "references").is_none() {
            return;
        }
        let Some(table) = self.name(cursor, false) else { return };
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
        let Some(name) = self.name(cursor, true) else { return };
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
                Some(t) => Err((t.pos, format!("'{}' is not allowed in a check expression", t.text))),
                None => Err((cursor.end, "check expression has no closing ')'".into())),
            }
        });
        match result {
            Ok(expr) => self.table_mut().checks.push(Check { comments, name, expr }),
            Err((pos, message)) => self.report(err(pos, "check", message)),
        }
    }

    fn open_settings(&mut self, keyword: &Token) {
        let comments = self.comments();
        if self.table_mut().settings.is_some() {
            self.report(err(keyword.pos, "setting", "a table has at most one settings block"));
        } else {
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
            (Kind::Word, "entity") => self.name(&mut cursor, true).map(Setting::Entity),
            (Kind::Word, "updated") => self.name(&mut cursor, false).map(Setting::Updated),
            (Kind::Word, "soft_delete") => self.name(&mut cursor, false).map(Setting::SoftDelete),
            (Kind::Word, "aes_version") => self.name(&mut cursor, false).map(Setting::AesVersion),
            (Kind::Word, "select") => self.expect(&mut cursor, "explicit").and_then(|_| {
                let mut columns = vec![self.name(&mut cursor, false)?];
                while cursor.peek().is_some() {
                    columns.push(self.name(&mut cursor, false)?);
                }
                Some(Setting::SelectExplicit(columns))
            }),
            (Kind::Word, "codec") => self.name(&mut cursor, false).and_then(|column| {
                let mut stages = vec![self.name(&mut cursor, false)?];
                while cursor.peek().is_some() {
                    stages.push(self.name(&mut cursor, false)?);
                }
                for stage in &stages {
                    if !CODEC_STAGES.contains(&stage.text.as_str()) {
                        self.report(err(stage.pos, "setting", format!("unknown codec stage '{}'", stage.text)));
                    }
                }
                Some(Setting::Codec(column, stages))
            }),
            (Kind::Word, "blind_index") => self.name(&mut cursor, false).and_then(|aes| Some(Setting::BlindIndex(aes, self.name(&mut cursor, false)?))),
            (Kind::Word, "navigation") => self.name(&mut cursor, false).and_then(|key| {
                let child = self.name(&mut cursor, true)?;
                let parent = self.name(&mut cursor, true)?;
                Some(Setting::Navigation(key, child, parent))
            }),
            (Kind::Word, "immutable") => Some(Setting::Immutable),
            (Kind::Word, "audit") => (|| {
                self.expect(&mut cursor, "into")?;
                let into = self.name(&mut cursor, false)?;
                self.expect(&mut cursor, "operation")?;
                let operation = self.name(&mut cursor, false)?;
                self.expect(&mut cursor, "action")?;
                let action = self.name(&mut cursor, false)?;
                self.expect(&mut cursor, "previous")?;
                let previous = self.name(&mut cursor, false)?;
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
        let Some(table) = self.name(&mut cursor, false) else { return };
        if self.expect(&mut cursor, "at").is_none() {
            return;
        }
        let mut coordinates = [0i64; 2];
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
                    magnitude.and_then(|m| i64::try_from(if negative { -m } else { m }).ok())
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

    fn finish(&mut self, line_count: usize) {
        let open = !matches!(self.context, Context::Top) || self.skip > 0;
        if open {
            let column = 1;
            self.report(err(Pos { line: line_count + 1, column }, "syntax", "the document ends inside a block"));
            match self.context {
                Context::Diagram => self.close_diagram(),
                Context::Table | Context::Settings => self.close_table(),
                Context::Top => {}
            }
        }
        self.document.trailing = self.comments();
    }
}
