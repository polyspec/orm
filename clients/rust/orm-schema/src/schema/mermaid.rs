//! Parses the hand-written Mermaid erDiagram (docs/schema.md) before
//! validation and name derivation.
//!
//! On top of standard Mermaid the diagram carries column attribute strings,
//! `%%` directives, and relationship labels that name the foreign-key
//! columns.

use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::sync::LazyLock;

use regex::Regex;

/// A parsed .mmd file.
#[derive(Debug, Default, Clone)]
pub struct Diagram {
    pub entities: Vec<DEntity>,
    pub relations: Vec<DRelation>,
    pub directives: Vec<Directive>,
    pub orm: Vec<OrmDirective>,
}

/// A namespaced `%% orm:<kind>` extension preserved in schema.json.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct OrmDirective {
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub args: BTreeMap<String, String>,
    pub raw: String,
    #[serde(skip)]
    pub line: usize,
}

#[derive(Debug, Clone)]
pub struct DEntity {
    pub name: String,
    pub comment: String,
    pub columns: Vec<DColumn>,
    pub line: usize,
}

#[derive(Debug, Clone, Default)]
pub struct DColumn {
    pub typ: String,
    pub name: String,
    pub keys: Vec<String>,
    pub comment: String,
    pub db_comment: String,
    pub line: usize,
    pub nullable: bool,
    pub default: Option<String>,
    pub auto: bool,
    pub on_update: bool,
    pub unsigned: bool,
    pub bool_: bool,
    pub int: bool,
    pub lazy: bool,
    pub styles: Vec<String>,
    pub reference: String,
    pub describe: String,
}

#[derive(Debug, Clone, Default)]
pub struct DRelation {
    pub parent: String,
    pub child: String,
    pub cardinality: String,
    pub label: String,
    pub line: usize,
    pub fks: Vec<String>,
    pub child_name: String,
    pub parent_name: String,
    pub on_delete: String,
}

#[derive(Debug, Clone, Default)]
pub struct Directive {
    pub kind: String,
    pub table: String,
    pub columns: Vec<String>,
    pub name: String,
    pub raw: String,
    pub line: usize,
}

/// A syntax error with its line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub line: usize,
    pub msg: String,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "line {}: {}", self.line, self.msg)
    }
}

impl std::error::Error for ParseError {}

fn perr(line: usize, msg: impl Into<String>) -> ParseError {
    ParseError { line, msg: msg.into() }
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid pattern")
}

static RE_ENTITY_OPEN: LazyLock<Regex> = LazyLock::new(|| re(r"^([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*$"));
static RE_COLUMN: LazyLock<Regex> = LazyLock::new(|| {
    re(r#"^([A-Za-z_][A-Za-z0-9_()\[\]]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?\s*(?:"([^"]*)")?\s*$"#)
});
static RE_RELATION: LazyLock<Regex> =
    LazyLock::new(|| re(r"^([A-Za-z_][A-Za-z0-9_]*)\s+([|}o]{1,2}[-.]{2}[|{o]{1,2})\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$"));
static RE_DIRECTIVE: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^%%\s*(unique|index|fulltext|check|blind_index|timestamps|aes_version|soft_delete|table_comment|column_comment|rename_table|rename_column)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$")
});
static RE_RELATION_NAMES: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(?:\(\s*([A-Za-z_][A-Za-z0-9_]*)?\s*/\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\))?\s*(.*)$"));
static RE_REF: LazyLock<Regex> = LazyLock::new(|| re(r"^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$"));
static RE_DIRECTIVE_IDENT: LazyLock<Regex> = LazyLock::new(|| re(r"^[a-z][a-z0-9_-]*$"));
static RE_ORM_NAME: LazyLock<Regex> = LazyLock::new(|| re(r"^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)?$"));

/// The options each `%% orm:<kind>` accepts. The syntax is checked here; a
/// higher-level generator gives the values meaning.
fn orm_directive_options(kind: &str) -> Option<&'static [&'static str]> {
    Some(match kind {
        "table" => &["entity", "name"],
        "foreign" => &["entity", "columns", "references", "name", "on_delete", "deferred"],
        "immutable" => &["entity"],
        "audit_log" => &["operation", "context", "change"],
        "audit" => &["entity", "mode", "service", "redact"],
        "field" => &["relation", "fk", "public", "required", "order"],
        "public-key" => &["entity", "field", "type", "unique", "stable"],
        "resource-key" => &["route", "param", "field"],
        "route" | "path" => &[],
        "scope" => &["route", "param", "field"],
        "filter" => &["route", "param", "field"],
        "operation" => &["route", "method"],
        "permission" => &["route", "action", "owner"],
        _ => return None,
    })
}

pub(crate) fn is_style_word(w: &str) -> bool {
    matches!(w, "aes" | "hex" | "gz" | "json" | "jsons" | "base64" | "serialize" | "ip" | "yaml")
}

/// Go's strings.Fields: splits on runs of Unicode white space.
pub fn fields(s: &str) -> Vec<&str> {
    s.split(char::is_whitespace).filter(|w| !w.is_empty()).collect()
}

/// Reads one .mmd file. It accepts exactly the subset in docs/schema.md and
/// fails on anything else.
pub fn parse(src: &str) -> Result<Diagram, ParseError> {
    let mut d = Diagram::default();
    let mut cur: Option<DEntity> = None;
    let mut last_route = String::new();
    let mut seen_orm = HashSet::new();
    let mut seen_header = false;
    let mut line = 0;
    for raw in split_lines(src) {
        line += 1;
        let t = raw.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with("%%") {
            if t.starts_with("%% orm:") {
                let mut x = parse_orm_directive(t, line)?;
                if x.kind == "route" {
                    last_route = x.name.clone();
                } else if x.kind == "path" {
                    if last_route.is_empty() {
                        return Err(perr(line, "%% orm:path requires a preceding route"));
                    }
                    x.args.insert("route".into(), last_route.clone());
                }
                let identity = orm_directive_identity(&x);
                if !seen_orm.insert(identity.clone()) {
                    return Err(perr(line, format!("duplicate ORM directive {identity}")));
                }
                d.orm.push(x);
                continue;
            }
            if let Some(m) = RE_DIRECTIVE.captures(t) {
                d.directives.push(parse_directive(&m[1], &m[2], &m[3], line)?);
            }
            continue;
        }
        if !seen_header {
            if t != "erDiagram" {
                return Err(perr(line, "file must start with erDiagram"));
            }
            seen_header = true;
            continue;
        }
        if let Some(entity) = cur.as_mut() {
            if t == "}" {
                d.entities.push(cur.take().unwrap());
                continue;
            }
            let Some(m) = RE_COLUMN.captures(t) else {
                return Err(perr(line, format!("bad column line in {}: {}", entity.name, go_quote(t))));
            };
            let mut c = DColumn {
                typ: m[1].to_owned(),
                name: m[2].to_owned(),
                comment: m.get(4).map_or("", |x| x.as_str()).to_owned(),
                line,
                ..Default::default()
            };
            if let Some(keys) = m.get(3) {
                if !keys.as_str().is_empty() {
                    c.keys = keys.as_str().split(',').map(|k| k.trim().to_owned()).collect();
                }
            }
            parse_column_comment(&mut c).map_err(|e| perr(line, e))?;
            entity.columns.push(c);
            continue;
        }
        if let Some(m) = RE_ENTITY_OPEN.captures(t) {
            cur = Some(DEntity { name: m[1].to_owned(), comment: String::new(), columns: Vec::new(), line });
            continue;
        }
        if let Some(m) = RE_RELATION.captures(t) {
            let mut r = DRelation {
                parent: m[1].to_owned(),
                cardinality: m[2].to_owned(),
                child: m[3].to_owned(),
                label: m[4].trim().trim_matches('"').to_owned(),
                line,
                ..Default::default()
            };
            parse_label(&mut r).map_err(|e| perr(line, e))?;
            d.relations.push(r);
            continue;
        }
        return Err(perr(line, format!("unrecognized line: {}", go_quote(t))));
    }
    if let Some(entity) = cur {
        return Err(perr(line, format!("unterminated entity {}", entity.name)));
    }
    if !seen_header {
        return Err(perr(0, "empty file"));
    }
    Ok(d)
}

/// Go's bufio.ScanLines: lines end at \n, a trailing \r is dropped, and a
/// final empty line is not reported.
fn split_lines(src: &str) -> impl Iterator<Item = &str> {
    let body = src.strip_suffix('\n').unwrap_or(src);
    let empty = src.is_empty();
    body.split('\n').filter(move |_| !empty).map(|l| l.strip_suffix('\r').unwrap_or(l))
}

/// Go's %q for the ASCII-printable text a schema line holds.
pub fn go_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{7}' => out.push_str("\\a"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\u{b}' => out.push_str("\\v"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c if !c.is_alphanumeric() && !c.is_ascii() && (c.is_whitespace() || c.is_control()) => {
                if (c as u32) < 0x10000 {
                    out.push_str(&format!("\\u{:04x}", c as u32))
                } else {
                    out.push_str(&format!("\\U{:08x}", c as u32))
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn orm_directive_identity(x: &OrmDirective) -> String {
    let arg = |k: &str| x.args.get(k).map(String::as_str).unwrap_or("");
    match x.kind.as_str() {
        "field" | "route" => return format!("{}:{}", x.kind, x.name),
        "path" => return format!("{}:{}", x.kind, arg("route")),
        _ => {}
    }
    if !arg("route").is_empty() {
        return format!("{}:{}:{}:{}:{}", x.kind, arg("route"), arg("param"), arg("method"), arg("action"));
    }
    match x.kind.as_str() {
        "public-key" => format!("{}:{}.{}", x.kind, arg("entity"), arg("field")),
        "resource-key" => format!("{}:{}:{}", x.kind, arg("route"), arg("param")),
        _ => format!("{}:{}", x.kind, x.raw),
    }
}

fn parse_orm_directive(line: &str, number: usize) -> Result<OrmDirective, ParseError> {
    let body = line.strip_prefix("%% orm:").unwrap_or(line).trim();
    if body.is_empty() {
        return Err(perr(number, "%% orm:<kind> requires a directive kind"));
    }
    let parts = super::audit::option_fields(body);
    let kind = parts[0].as_str();
    if !RE_DIRECTIVE_IDENT.is_match(kind) {
        return Err(perr(number, format!("invalid ORM directive kind {kind}")));
    }
    let Some(allowed) = orm_directive_options(kind) else {
        return Err(perr(number, format!("unknown ORM directive {kind}")));
    };
    let mut x = OrmDirective { kind: kind.to_owned(), name: String::new(), args: BTreeMap::new(), raw: body.to_owned(), line: number };
    let mut positional = &parts[1..];
    if let Some(first) = positional.first() {
        if !first.contains('=') {
            if !RE_ORM_NAME.is_match(first) && kind != "path" {
                return Err(perr(number, format!("invalid ORM directive identifier {first}")));
            }
            x.name = (*first).to_owned();
            positional = &positional[1..];
        }
    }
    for token in positional {
        let (key, value) = match token.split_once('=') {
            Some((k, v)) if RE_DIRECTIVE_IDENT.is_match(k) && !v.is_empty() => (k, v),
            _ => return Err(perr(number, format!("% orm:{kind} requires key=value options"))),
        };
        if !allowed.contains(&key) {
            return Err(perr(number, format!("% orm:{kind}: unknown option {key}")));
        }
        if x.args.contains_key(key) {
            return Err(perr(number, format!("% orm:{kind}: duplicate option {key}")));
        }
        x.args.insert(key.to_owned(), value.to_owned());
    }
    Ok(x)
}

fn parse_column_comment(c: &mut DColumn) -> Result<(), String> {
    let comment = c.comment.clone();
    let words = fields(&comment);
    let mut desc = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let w = words[i];
        if w == "?" {
            c.nullable = true;
        } else if let Some(v) = w.strip_prefix('=') {
            c.default = Some(v.to_owned());
        } else if w == "auto" {
            c.auto = true;
        } else if w == "onupdate" {
            c.on_update = true;
        } else if w == "unsigned" {
            c.unsigned = true;
        } else if w == "bool" {
            c.bool_ = true;
        } else if w == "int" {
            c.int = true;
        } else if w == "lazy" {
            c.lazy = true;
        } else if w == "->" {
            if i + 1 >= words.len() || !RE_REF.is_match(words[i + 1]) {
                return Err(format!("column {}: '->' must be followed by table.column", c.name));
            }
            c.reference = words[i + 1].to_owned();
            i += 1;
        } else if w.contains(',') {
            if w.split(',').all(is_style_word) {
                c.styles.extend(w.split(',').map(str::to_owned));
            } else {
                desc.push(w);
            }
        } else if is_style_word(w) {
            c.styles.push(w.to_owned());
        } else {
            desc.push(w);
        }
        i += 1;
    }
    c.describe = desc.join(" ");
    if c.bool_ && c.int {
        return Err(format!("column {}: bool and int are exclusive", c.name));
    }
    Ok(())
}

fn parse_label(r: &mut DRelation) -> Result<(), String> {
    if r.label.is_empty() {
        return Err(format!("relation {} -> {}: label must name the FK column", r.parent, r.child));
    }
    let bad = |r: &DRelation| format!("relation {} -> {}: bad label {}", r.parent, r.child, go_quote(&r.label));
    let label = r.label.clone();
    let mut rest: &str = &label;
    if rest.starts_with('(') {
        let Some(close) = rest.find(')') else { return Err(bad(r)) };
        for value in rest[1..close].split(',') {
            let value = value.trim();
            if !RE_DIRECTIVE_IDENT.is_match(value) {
                return Err(format!("relation {} -> {}: bad FK column {}", r.parent, r.child, go_quote(value)));
            }
            r.fks.push(value.to_owned());
        }
        rest = rest[close + 1..].trim();
    } else {
        let words = fields(rest);
        if words.is_empty() || !RE_DIRECTIVE_IDENT.is_match(words[0]) {
            return Err(bad(r));
        }
        r.fks = vec![words[0].to_owned()];
        rest = rest.strip_prefix(words[0]).unwrap_or(rest).trim();
    }
    let Some(m) = RE_RELATION_NAMES.captures(rest) else { return Err(bad(r)) };
    r.child_name = m.get(1).map_or("", |x| x.as_str()).to_owned();
    r.parent_name = m.get(2).map_or("", |x| x.as_str()).to_owned();
    for w in fields(m.get(3).map_or("", |x| x.as_str())) {
        match w {
            "cascade" | "setnull" => r.on_delete = w.to_owned(),
            _ => return Err(format!("relation {} -> {}: unknown label word {}", r.parent, r.child, go_quote(w))),
        }
    }
    Ok(())
}

fn parse_directive(kind: &str, table: &str, rest: &str, line: usize) -> Result<Directive, ParseError> {
    let mut d = Directive { kind: kind.to_owned(), table: table.to_owned(), raw: rest.trim().to_owned(), line, ..Default::default() };
    let ident = |s: &str| RE_DIRECTIVE_IDENT.is_match(s);
    match kind {
        "unique" | "index" | "fulltext" => {
            let open = d.raw.find('(');
            let close = d.raw.rfind(')');
            let (Some(0), Some(close)) = (open, close) else {
                return Err(perr(line, format!("%% {kind} {table}: expected (col, …)")));
            };
            for c in d.raw[1..close].split(',') {
                let c = c.trim();
                if c.is_empty() {
                    return Err(perr(line, format!("%% {kind} {table}: empty column")));
                }
                d.columns.push(c.to_owned());
            }
            d.name = d.raw[close + 1..].trim().to_owned();
            if kind != "index" && !d.name.is_empty() {
                return Err(perr(line, format!("%% {kind}: only index takes a name")));
            }
        }
        "check" => {
            let parsed = d.raw.split_once(':').filter(|(name, body)| ident(name.trim()) && !body.trim().is_empty());
            let Some((name, body)) = parsed else {
                return Err(perr(line, "%% check <table> <name> : <expression>"));
            };
            let (name, body) = (name.trim().to_owned(), body.trim().to_owned());
            d.name = name;
            d.raw = body;
        }
        "timestamps" => {
            d.columns = fields(&d.raw).into_iter().map(str::to_owned).collect();
            if d.columns.len() != 2 {
                return Err(perr(line, "%% timestamps <table> <created> <updated>"));
            }
        }
        "aes_version" => {
            d.columns = fields(&d.raw).into_iter().map(str::to_owned).collect();
            if d.columns.len() != 1 || !ident(&d.columns[0]) {
                return Err(perr(line, "%% aes_version <table> <version_column>"));
            }
        }
        "soft_delete" => {
            d.columns = fields(&d.raw).into_iter().map(str::to_owned).collect();
            if d.columns.len() != 1 {
                return Err(perr(line, "%% soft_delete <table> <nullable_datetime_column>"));
            }
        }
        "blind_index" => {
            d.columns = fields(&d.raw).into_iter().map(str::to_owned).collect();
            if d.columns.len() != 2 || !ident(&d.columns[0]) || !ident(&d.columns[1]) {
                return Err(perr(line, "%% blind_index <table> <encrypted_column> <index_column>"));
            }
        }
        "table_comment" => {
            if d.raw.is_empty() || !d.raw.starts_with('"') || !d.raw.ends_with('"') {
                return Err(perr(line, "%% table_comment <table> \"text\""));
            }
            d.raw = d.raw.trim_matches('"').to_owned();
        }
        "column_comment" => {
            let parts: Vec<String> = fields(&d.raw).into_iter().map(str::to_owned).collect();
            let text = if parts.is_empty() { "" } else { d.raw[parts[0].len()..].trim() };
            if parts.len() < 2 || !text.starts_with('"') || !text.ends_with('"') {
                return Err(perr(line, "%% column_comment <table> <column> \"text\""));
            }
            let text = text.trim_matches('"').to_owned();
            d.columns = vec![parts[0].clone()];
            d.raw = text;
        }
        "rename_table" => {
            let parts = fields(&d.raw);
            if parts.len() != 1 || !ident(parts[0]) {
                return Err(perr(line, "%% rename_table <new_table> <old_table>"));
            }
            d.name = parts[0].to_owned();
        }
        "rename_column" => {
            let parts: Vec<String> = fields(&d.raw).into_iter().map(str::to_owned).collect();
            if parts.len() != 2 || !ident(&parts[0]) || !ident(&parts[1]) {
                return Err(perr(line, "%% rename_column <table> <new_column> <old_column>"));
            }
            d.columns = vec![parts[0].clone()];
            d.name = parts[1].clone();
        }
        _ => {}
    }
    Ok(d)
}
