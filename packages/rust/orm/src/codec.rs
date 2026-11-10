//! Column-style codecs (docs/spec/codec.md): ordered_json, serialize, base64, gz, yaml.
//! Styles are listed in write order; `decode` applies them in reverse. A first `gz` or
//! `base64` stage takes a string value and stores its UTF-8 text (docs/spec/codec.md, Stage lists).

use std::io::{Read, Write};
use std::sync::LazyLock;

use base64::Engine as _;
use ordered_json as strict_json;
use regex::Regex;
use serde_json::Value;

use crate::codes::{CODEC_DECODE, CODEC_ENCODE, CODEC_UNSUPPORTED};
use crate::value::{Param, StyledValue, Val};
use crate::{Error, Result};

fn err(code: &str, msg: impl Into<String>) -> Error {
    Error::Engine { code: code.into(), msg: msg.into(), source: None }
}

/// The stage text `msg` of a failure of the library a stage reads or writes with, which keeps that failure as its
/// source (COD-41).
fn err_cause(code: &str, msg: impl Into<String>, cause: impl std::error::Error + Send + Sync + 'static) -> Error {
    Error::Engine { code: code.into(), msg: msg.into(), source: Some(Box::new(cause)) }
}

/// The levels of nested lists and maps that every stage reads and writes; a list or a map at the next level is refused
/// (COD-70 `json-depth`, `serialize-depth`, `yaml-depth` and their write rules).
const NESTING_LEVELS: usize = 256;

/// Stored cell → decoded value, or `Val::Null` for SQL NULL. The `ordered_json`
/// stage returns `Val::Ordered`; the other stages return `Val::Json`.
pub fn decode(styles: &[String], raw: &Val) -> Result<Val> {
    check_styles(styles.iter().map(String::as_str))?;
    let mut cur: Vec<u8> = match raw {
        Val::Null => return Ok(Val::Null),
        // a driver-parsed JSON cell: only a bare json style applies
        Val::Json(v) if styles.len() == 1 && styles[0] == "ordered_json" => v.to_string().into_bytes(),
        Val::Str(s) => s.as_bytes().to_vec(),
        Val::Bytes(b) => b.clone(),
        _ => return Err(err(CODEC_DECODE, "cell is not bytes")),
    };
    // An empty cell is CODEC_DECODE, except under a last base64 stage and under no stage, whose encoders write an empty
    // cell for empty text (docs/spec/codec.md COD-14).
    if cur.is_empty() && styles.last().is_some_and(|last| last != "base64") {
        return Err(err(CODEC_DECODE, "styled cell is empty"));
    }
    let mut value: Option<Val> = None;
    // check_styles puts a value stage first in the list, which a decode applies last, so no stage follows a decoded value
    // (COD-72).
    for st in styles.iter().rev() {
        match st.as_str() {
            "gz" => {
                let mut out = Vec::new();
                flate2::read::ZlibDecoder::new(cur.as_slice()).read_to_end(&mut out).map_err(|error| err_cause(CODEC_DECODE, "gz: bad zlib stream", error))?;
                cur = out;
            }
            "base64" => {
                let text = std::str::from_utf8(&cur).map_err(|error| err_cause(CODEC_DECODE, "base64: bad input", error))?;
                // A stored cell is decoded only in the form the encoder writes (docs/spec/codec.md). STANDARD rejects whitespace, missing padding,
                // and nonzero padding bits.
                cur = base64::engine::general_purpose::STANDARD.decode(text).map_err(|error| err_cause(CODEC_DECODE, "base64: bad input", error))?;
            }
            "serialize" => value = Some(Val::Json(php_unserialize(&cur)?)),
            "yaml" => {
                value = Some(Val::Json(yaml_decode(&cur)?));
            }
            "ordered_json" => {
                value = Some(Val::Ordered(strict_json::parse_bytes(&cur).map_err(|error| {
                    // The ordered-json parser reads 256 levels and refuses the next one by its own kind (`json-depth-read`).
                    let text = if error.kind() == strict_json::ErrorKind::MaximumDepthExceeded {
                        "json: value nesting exceeds 256 levels"
                    } else {
                        "json: the cell is not JSON"
                    };
                    err_cause(CODEC_DECODE, text, error)
                })?))
            }
            other => return Err(err(CODEC_UNSUPPORTED, format!("style {other}"))),
        }
    }
    // Without a value stage (no stage, or a list that starts with gz or base64) the value is the text of the bytes.
    Ok(match value {
        Some(value) => value,
        None => Val::Str(String::from_utf8(cur).map_err(|error| err_cause(CODEC_DECODE, "decoded text is not valid UTF-8", error))?),
    })
}

/// Refuses a style that no stage names and a value stage outside the first position, before any value or cell is read
/// (docs/spec/codec.md COD-35).
fn check_styles<'a>(styles: impl IntoIterator<Item = &'a str>) -> Result<()> {
    for (i, st) in styles.into_iter().enumerate() {
        match st {
            "gz" | "base64" => {}
            "ordered_json" | "serialize" | "yaml" if i == 0 => {}
            "ordered_json" | "serialize" | "yaml" => return Err(err(CODEC_UNSUPPORTED, format!("{st} must be the first style"))),
            other => return Err(err(CODEC_UNSUPPORTED, format!("style {other}"))),
        }
    }
    Ok(())
}

/// A first `gz` or `base64` stage takes bytes, so the value is a string and the stage encodes its UTF-8 text; an empty stage
/// list writes that text as it is.
fn takes_text(stage: Option<&str>) -> bool {
    matches!(stage, None | Some("gz" | "base64"))
}

/// The stored text of an ordered-json value: its source text with the insignificant whitespace removed, so the
/// member order and the repeated member names of the source survive (DIA-26). A value without source text is
/// written from its compact form.
pub(crate) fn ordered_text(v: &strict_json::Value) -> String {
    let raw = v.raw();
    if raw.is_empty() {
        return v.compact();
    }
    let mut out = String::with_capacity(raw.len());
    let mut in_string = false;
    let mut escaped = false;
    for c in raw.chars() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            ' ' | '\t' | '\n' | '\r' => {}
            '"' => {
                in_string = true;
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// An ordered-json value → stored representation. The first stage is
/// `ordered_json` and writes the stored text of the value (`ordered_text`), including JSON null.
pub fn encode_ordered(styles: &[&str], v: StyledValue<&strict_json::Value>) -> Result<Param> {
    check_styles(styles.iter().copied())?;
    let StyledValue::Value(v) = v else { return Ok(Param::Null) };
    match styles.first() {
        Some(&"ordered_json") => finish(&styles[1..], Written::Text(ordered_text(v))),
        // An ordered-json value is written by the ordered_json stage only (COD-16); a first gz or base64 stage and an
        // empty list take a string value.
        Some(&st @ ("serialize" | "yaml")) => Err(err(CODEC_ENCODE, format!("{st}: an ordered-json value is written only by the ordered_json stage"))),
        first => Err(err(CODEC_ENCODE, text_kind(first.copied()))),
    }
}

/// The text of `text-kind` (COD-70) for the first stage of a list that takes a string value.
fn text_kind(first: Option<&str>) -> String {
    match first {
        None => "an empty stage list takes a string value".to_owned(),
        Some(st) => format!("a first {st} stage takes a string value"),
    }
}

/// What a stage has written: text, or the bytes of a gz stage.
enum Written {
    Text(String),
    Bytes(Vec<u8>),
}

impl Written {
    fn into_bytes(self) -> Vec<u8> {
        match self {
            Written::Text(text) => text.into_bytes(),
            Written::Bytes(bytes) => bytes,
        }
    }
}

/// Applies the stages that follow the first one (base64, gz), which check_styles has checked, and binds what the last
/// one wrote: text, or the bytes of a last gz stage.
fn finish(styles: &[&str], mut cur: Written) -> Result<Param> {
    for st in styles {
        cur = encode_binary_stage(st, cur)?;
    }
    Ok(match cur {
        Written::Text(text) => Param::Str(text),
        Written::Bytes(bytes) => Param::Bytes(bytes),
    })
}

fn encode_binary_stage(style: &str, cur: Written) -> Result<Written> {
    match style {
        "base64" => Ok(Written::Text(base64::engine::general_purpose::STANDARD.encode(cur.into_bytes()))),
        "gz" => {
            let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
            enc.write_all(&cur.into_bytes()).map_err(|error| err_cause(CODEC_ENCODE, "gz: the compression failed", error))?;
            Ok(Written::Bytes(enc.finish().map_err(|error| err_cause(CODEC_ENCODE, "gz: the compression failed", error))?))
        }
        other => Err(err(CODEC_UNSUPPORTED, format!("style {other}"))),
    }
}

/// Value → stored representation as a bind parameter (`Str`, or `Bytes` for gz).
pub fn encode(styles: &[&str], v: StyledValue<&Value>) -> Result<Param> {
    check_styles(styles.iter().copied())?;
    let StyledValue::Value(value) = v else { return Ok(Param::Null) };
    let first = styles.first().copied();
    let written = match first {
        Some("serialize") => {
            let mut s = String::new();
            php_serialize(&mut s, value, 1)?;
            Written::Text(s)
        }
        Some("yaml") => Written::Text(yaml_encode(value)?),
        Some("ordered_json") => Written::Text(json_encode(value)?),
        _ => match value {
            Value::String(text) => Written::Text(text.clone()),
            _ => return Err(err(CODEC_ENCODE, text_kind(first))),
        },
    };
    // A first gz or base64 stage encodes the UTF-8 of the string; the stages after the first apply in order.
    let rest = if takes_text(first) { styles } else { &styles[1..] };
    finish(rest, written)
}

/// The check of the setter of a styled column (COD-73): the value is encoded by the codec stages of `styles`, the styles
/// of the column, without its host stages, as `encode` of those stages does, so the setter fails at the call with the
/// error of the first rule of COD-70 that the value meets, before it changes the model.
pub fn check_setter(styles: &[&str], value: &Value) -> Result<()> {
    let codec: Vec<&str> = styles.iter().copied().filter(|style| !is_host(style)).collect();
    encode(&codec, StyledValue::Value(value)).map(drop)
}

/// [`check_setter`] for the ordered-json value of a column whose first stage is `ordered_json`.
pub fn check_setter_ordered(styles: &[&str], value: &strict_json::Value) -> Result<()> {
    let codec: Vec<&str> = styles.iter().copied().filter(|style| !is_host(style)).collect();
    encode_ordered(&codec, StyledValue::Value(value)).map(drop)
}

/// The ordered-json text of a common value. A value nested deeper than the 256 levels that the ordered-json parser reads has
/// no such text (`json-depth` of COD-70), which the walk of the value finds before serde_json writes it; any failure of
/// the library is `json-text`.
fn json_encode(value: &Value) -> Result<String> {
    write_check(value, "json", false)?;
    let raw = serde_json::to_vec(value).map_err(|error| err_cause(CODEC_ENCODE, "json: the value has no JSON text", error))?;
    let parsed = strict_json::parse_bytes(&raw).map_err(|error| err_cause(CODEC_ENCODE, "json: the value has no JSON text", error))?;
    Ok(strict_json::stringify(&parsed))
}

/// Walks a value to write in its node order, without recursion: a list or a map at level 257 is `<style>-depth-write`
/// (`json-depth` for json) before the nodes inside it, and with `numbers` an integer beyond i64, which the common value
/// model (COD-16) does not hold, is `yaml-int-range-write` where it stands (COD-70).
fn write_check(value: &Value, style: &str, numbers: bool) -> Result<()> {
    let mut nodes: Vec<(&Value, usize)> = vec![(value, 1)];
    while let Some((node, level)) = nodes.pop() {
        match node {
            Value::Array(_) | Value::Object(_) if level > NESTING_LEVELS => {
                return Err(err(CODEC_ENCODE, format!("{style}: value nesting exceeds 256 levels")));
            }
            // The stack takes the members in reverse, so that they are met in their order.
            Value::Array(items) => nodes.extend(items.iter().rev().map(|item| (item, level + 1))),
            Value::Object(map) => nodes.extend(map.values().rev().map(|item| (item, level + 1))),
            Value::Number(number) if numbers && number.is_u64() && number.as_i64().is_none() => {
                return Err(err(CODEC_ENCODE, format!("{style}: integer is outside the i64 range")));
            }
            _ => {}
        }
    }
    Ok(())
}

// ---- yaml: read by the YAML reader of orm (COD-74 to COD-80), written by serde-saphyr ----

/// The refusal of the rule `message`, which names no position (COD-70), with the failure that found it, if any.
fn yaml_refusal(message: &str, source: Option<YamlCause>) -> Error {
    Error::Engine { code: CODEC_DECODE.into(), msg: format!("yaml: {message}"), source }
}

/// The failure that found a refused plain scalar.
type YamlCause = Box<dyn std::error::Error + Send + Sync + 'static>;
/// A refused plain scalar: the rule it breaks and the failure that found it, if any.
type YamlScalarRefusal = (&'static str, Option<YamlCause>);

static YAML_CORE_INT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\A(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)\z").unwrap());
static YAML_CORE_FLOAT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\A(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))\z").unwrap());

/// The integer of a plain scalar that the core schema reads as an integer: decimal, `0o` octal or `0x` hexadecimal.
fn yaml_core_int(text: &str) -> std::result::Result<i64, std::num::ParseIntError> {
    match (text.strip_prefix("0o"), text.strip_prefix("0x")) {
        (Some(digits), _) => i64::from_str_radix(digits, 8),
        (_, Some(digits)) => i64::from_str_radix(digits, 16),
        _ => text.parse::<i64>(),
    }
}

/// Resolves a plain scalar by the tags of the YAML 1.2 core schema (YAML 1.2.2, 10.3.2, COD-79): null, bool, int and
/// float by their regular expressions, with the case as written, and str otherwise. An integer outside i64 and a float
/// that is not finite are outside the common value model.
fn yaml_core_scalar(text: String) -> std::result::Result<Value, YamlScalarRefusal> {
    Ok(match text.as_str() {
        "" | "~" | "null" | "Null" | "NULL" => Value::Null,
        "true" | "True" | "TRUE" => Value::Bool(true),
        "false" | "False" | "FALSE" => Value::Bool(false),
        _ if YAML_CORE_INT.is_match(&text) => {
            Value::from(yaml_core_int(&text).map_err(|error| ("integer is outside the i64 range", Some(Box::new(error) as YamlCause)))?)
        }
        _ if YAML_CORE_FLOAT.is_match(&text) => {
            // .inf and .nan are YAML floats that are not finite; Rust reads them without the dot.
            let float = match text.trim_start_matches(['+', '-']).strip_prefix('.') {
                Some(word) if word.eq_ignore_ascii_case("inf") || word.eq_ignore_ascii_case("nan") => return Err(("number is not finite", None)),
                // YAML_CORE_FLOAT admits only forms that Rust reads as f64, the nearest binary64 with a tie to the even
                // one, so no scalar reaches this guard; it states yaml-parse, with the failure of the read as the cause
                // (COD-72).
                _ => text.parse::<f64>().map_err(|error| ("the stream does not parse", Some(Box::new(error) as YamlCause)))?,
            };
            match serde_json::Number::from_f64(float) {
                Some(number) => Value::Number(number),
                None => return Err(("number is not finite", None)),
            }
        }
        _ => Value::String(text),
    })
}

/// The string of a plain map key (COD-79): an integer is its decimal text, and a null, a bool or a float, finite or
/// not, is `yaml-key-scalar`.
fn yaml_core_key(text: String) -> std::result::Result<String, YamlScalarRefusal> {
    const KEY_SCALAR: &str = "map keys must be strings or integers";
    Ok(match text.as_str() {
        "" | "~" | "null" | "Null" | "NULL" | "true" | "True" | "TRUE" | "false" | "False" | "FALSE" => return Err((KEY_SCALAR, None)),
        _ if YAML_CORE_INT.is_match(&text) => {
            yaml_core_int(&text).map_err(|error| ("integer is outside the i64 range", Some(Box::new(error) as YamlCause)))?.to_string()
        }
        _ if YAML_CORE_FLOAT.is_match(&text) => return Err((KEY_SCALAR, None)),
        _ => text,
    })
}

/// Whether a character may appear in a YAML stream (YAML 1.2.2, 5.1, c-printable). A byte order
/// mark is the encoding mark at the start of the stream (5.2) and never content.
fn yaml_printable(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r' | ' '..='~' | '\u{85}' | '\u{a0}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..) && c != '\u{feff}'
}

/// Reads one YAML document into the common value model with the YAML reader of orm (COD-74). The stream rules
/// `yaml-utf8` and `yaml-printable` hold over the whole stream before the reader reads the characters after the one
/// byte order mark that may start it (COD-75).
fn yaml_decode(bytes: &[u8]) -> Result<Value> {
    let source = std::str::from_utf8(bytes).map_err(|error| err_cause(CODEC_DECODE, "yaml: the stream is not UTF-8", error))?;
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    if source.chars().any(|c| !yaml_printable(c)) {
        return Err(err(CODEC_DECODE, "yaml: the stream holds a character that is not printable"));
    }
    yaml_reader::read(source)
}

/// Writes a common value as one YAML document with serde-saphyr, which quotes every string the
/// core schema would read as another value and escapes every character outside c-printable. A
/// number outside the common value model returns CODEC_ENCODE. The written text is read back by the
/// reader, and a text that does not read back as the value returns CODEC_ENCODE instead of storing it.
fn yaml_encode(value: &Value) -> Result<String> {
    write_check(value, "yaml", true)?;
    let text = serde_saphyr::to_string(value).map_err(|error| err_cause(CODEC_ENCODE, "yaml: the value has no YAML text", error))?;
    const READ_BACK: &str = "yaml: the written text does not read back as the value";
    match yaml_decode(text.as_bytes()) {
        Ok(read) if read == *value => Ok(text),
        // The text and the value are data, so the refusal names neither (INT-163); a failed read is its cause (COD-71).
        Ok(_) => Err(err(CODEC_ENCODE, READ_BACK)),
        Err(error) => Err(err_cause(CODEC_ENCODE, READ_BACK, error)),
    }
}

/// The YAML reader of orm (docs/spec/codec.md COD-74 to COD-80): it accepts a stream exactly when the productions of
/// YAML 1.2.2 hold it and the stream holds one document, and builds the value of that document in the same pass, in the
/// order of the stream, so the first rule that the stream breaks is the error (COD-80). It keeps its state in explicit
/// stacks and never recurses, so no depth of the caller's stack decides a stream; the builder refuses a list or a map
/// at level 257 by `yaml-depth`.
mod yaml_reader {
    use serde_json::{Map, Value};

    use super::{err_cause, yaml_core_key, yaml_core_scalar, yaml_refusal, YamlCause};
    use crate::codes::CODEC_DECODE;
    use crate::Result;

    /// The characters of an implicit key, from its first character to its `:` (COD-76, COD-77).
    const KEY_LIMIT: usize = 1024;
    /// What the reader sees past the last character. U+0000 is not printable, so no stream holds it (COD-66).
    const END: char = '\0';
    const DOCUMENTS: &str = "multiple documents are not supported";

    /// Where the stream leaves the grammar of the reader, each counted from 1, the column in Unicode characters and the
    /// byte order mark not counted (COD-80). It is the cause of `yaml-parse` (COD-71).
    #[derive(Debug)]
    pub(super) struct YamlSyntaxError {
        pub(super) line: usize,
        pub(super) column: usize,
    }

    impl std::fmt::Display for YamlSyntaxError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "the stream leaves the YAML grammar at line {}, column {}", self.line, self.column)
        }
    }

    impl std::error::Error for YamlSyntaxError {}

    /// Why the reader stops: the stream leaves the grammar at a character, or a rule of COD-70 refuses a node.
    enum Refusal {
        Parse(usize),
        Rule(&'static str, Option<YamlCause>),
    }

    type Step<T> = std::result::Result<T, Refusal>;

    fn rule<T>(message: &'static str) -> Step<T> {
        Err(Refusal::Rule(message, None))
    }

    fn white(c: char) -> bool {
        c == ' ' || c == '\t'
    }

    fn eol(c: char) -> bool {
        c == '\n' || c == END
    }

    fn white_or_eol(c: char) -> bool {
        white(c) || eol(c)
    }

    /// `ns-char` [34]: a printable character that is not white space or a line break.
    fn ns_char(c: char) -> bool {
        !white_or_eol(c)
    }

    /// `c-flow-indicator` [23].
    fn flow_indicator(c: char) -> bool {
        matches!(c, ',' | '[' | ']' | '{' | '}')
    }

    /// `c-indicator` [22].
    fn indicator(c: char) -> bool {
        matches!(c, '-' | '?' | ':' | ',' | '[' | ']' | '{' | '}' | '#' | '&' | '*' | '!' | '|' | '>' | '\'' | '"' | '%' | '@' | '`')
    }

    /// `ns-plain-safe(c)` [129]: in a flow collection a flow indicator is not safe.
    fn plain_safe(c: char, flow: bool) -> bool {
        ns_char(c) && !(flow && flow_indicator(c))
    }

    /// A node that starts with a flow collection or a quoted scalar: its value may be adjacent to the `:` ([148]).
    fn json_start(c: char) -> bool {
        matches!(c, '[' | '{' | '\'' | '"')
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum BlockCtx {
        /// `block-in`: the entries of a sequence.
        In,
        /// `block-out`: the keys and values of a mapping, whose sequence may stand at the indentation of its key.
        Out,
    }

    /// Where a block node starts relative to the indicator before it.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Inline {
        /// At the start of a line: the node starts on this line or a later one.
        LineStart,
        /// After `-`, `?` or an explicit `:`, where a compact collection may start on the line ([185]).
        Indicator,
        /// After the `:` of an implicit key, where no block collection starts on the line.
        ImplicitValue,
        /// After `---`, where no block collection starts on the line ([200]).
        DocStart,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum FlowCtx {
        /// `flow-out`: a flow node in a block collection.
        Out,
        /// `flow-in`: a node inside a flow collection.
        In,
        /// `flow-key`: a node inside a flow collection that is an implicit key, on one line.
        Key,
        /// `block-key`: an implicit key of a block mapping, on one line.
        BlockKey,
    }

    impl FlowCtx {
        /// Whether a flow indicator ends a plain scalar.
        fn flow(self) -> bool {
            matches!(self, FlowCtx::In | FlowCtx::Key)
        }

        /// Whether a scalar or a flow collection may span lines.
        fn multi_line(self) -> bool {
            matches!(self, FlowCtx::Out | FlowCtx::In)
        }

        /// The context of the nodes inside a flow collection (`in-flow(c)` [136]).
        fn inner(self) -> FlowCtx {
            match self {
                FlowCtx::Key | FlowCtx::BlockKey => FlowCtx::Key,
                FlowCtx::Out | FlowCtx::In => FlowCtx::In,
            }
        }
    }

    enum Next {
        /// A block node whose parent is at indentation `n`.
        Block {
            n: isize,
            ctx: BlockCtx,
            inline: Inline,
        },
        /// A flow node whose lines after the first are indented by at least `n` spaces.
        Flow {
            n: isize,
            ctx: FlowCtx,
        },
        /// The node of the top frame finished; the frame continues.
        Resume,
        Done,
    }

    /// What a character of a quoted scalar is to its style (`Reader::quoted`).
    enum Quoted {
        /// A character of the content.
        Content,
        /// A doubled quote or an escape, read up to this index.
        Next(usize),
        /// The closing quote.
        Close,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum MapPhase {
        ImplicitKey,
        ExplicitKey,
        Value,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum FlowPhase {
        /// After `[`, `{` or `,`.
        Open,
        /// After an entry of a flow sequence.
        Entry,
        /// After the `?` of a pair of a flow sequence.
        Explicit,
        /// After a key; a key that is a flow collection or a quoted scalar may have an adjacent value.
        Key {
            json: bool,
        },
        Value,
    }

    #[derive(Clone, Copy)]
    enum Frame {
        Root,
        BlockSeq {
            col: usize,
        },
        BlockMap {
            col: usize,
            phase: MapPhase,
        },
        /// A flow node of a block collection, which only white space and a comment follow on its last line.
        FlowInBlock,
        /// A node at the place of a key of a block mapping that is no implicit key (COD-80): its nodes are met in their
        /// order, and then the stream leaves the grammar after it.
        Detached,
        FlowSeq {
            n: isize,
            ctx: FlowCtx,
            phase: FlowPhase,
        },
        FlowMap {
            n: isize,
            ctx: FlowCtx,
            phase: FlowPhase,
        },
        /// A single pair of a flow sequence, a map of one level (COD-77).
        FlowPair {
            n: isize,
            ctx: FlowCtx,
            phase: FlowPhase,
        },
    }

    enum Slot {
        Seq(Vec<Value>),
        Map(Map<String, Value>, Option<String>),
        Detached,
    }

    /// Builds the value of the document and meets the rules of each node where it starts (COD-70, COD-79).
    #[derive(Default)]
    struct Builder {
        slots: Vec<Slot>,
        levels: usize,
        root: Option<Value>,
    }

    impl Builder {
        fn at_key(&self) -> bool {
            matches!(self.slots.last(), Some(Slot::Map(_, None)))
        }

        /// Opens a sequence or a map: the nesting rule of its level, then the rule of a map key (COD-70).
        fn open(&mut self, map: bool) -> Step<()> {
            if self.levels == super::NESTING_LEVELS {
                return rule("value nesting exceeds 256 levels");
            }
            if self.at_key() {
                return rule("map keys must be scalar strings");
            }
            self.slots.push(if map { Slot::Map(Map::new(), None) } else { Slot::Seq(Vec::new()) });
            self.levels += 1;
            Ok(())
        }

        fn close(&mut self) {
            let value = match self.slots.pop() {
                Some(Slot::Seq(items)) => Value::Array(items),
                Some(Slot::Map(map, _)) => Value::Object(map),
                Some(Slot::Detached) | None => return,
            };
            self.levels -= 1;
            self.place(value);
        }

        fn place(&mut self, value: Value) {
            match self.slots.last_mut() {
                Some(Slot::Seq(items)) => items.push(value),
                Some(Slot::Map(map, key)) => {
                    if let Some(name) = key.take() {
                        map.insert(name, value);
                    }
                }
                Some(Slot::Detached) => {}
                None => self.root = Some(value),
            }
        }

        /// A scalar: a plain one resolves by the core schema, and a quoted or block one is its string (COD-79). A key is
        /// met before its value, and a repeated key at the key that repeats (COD-70).
        fn scalar(&mut self, text: String, plain: bool) -> Step<()> {
            if self.at_key() {
                let name = if plain { yaml_core_key(text).map_err(|(message, cause)| Refusal::Rule(message, cause))? } else { text };
                if let Some(Slot::Map(map, key)) = self.slots.last_mut() {
                    if map.contains_key(&name) {
                        return rule("duplicate map key");
                    }
                    *key = Some(name);
                }
                return Ok(());
            }
            let value = if plain { yaml_core_scalar(text).map_err(|(message, cause)| Refusal::Rule(message, cause))? } else { Value::String(text) };
            self.place(value);
            Ok(())
        }

        fn null(&mut self) -> Step<()> {
            self.scalar(String::new(), true)
        }
    }

    /// Reads the stream `source`, whose byte order mark is removed and whose characters are printable (COD-75).
    pub(super) fn read(source: &str) -> Result<Value> {
        let mut reader = Reader::new(source);
        match reader.stream() {
            Ok(()) => Ok(reader.b.root.take().unwrap_or(Value::Null)),
            Err(Refusal::Rule(message, cause)) => Err(yaml_refusal(message, cause)),
            Err(Refusal::Parse(at)) => {
                let (line, column) = reader.position(at);
                Err(err_cause(CODEC_DECODE, "yaml: the stream does not parse", YamlSyntaxError { line, column }))
            }
        }
    }

    struct Reader {
        /// The characters of the stream, each line break one LF (COD-75).
        s: Vec<char>,
        /// The index of the first character of each line.
        lines: Vec<usize>,
        pos: usize,
        b: Builder,
        frames: Vec<Frame>,
    }

    impl Reader {
        fn new(source: &str) -> Reader {
            let mut s = Vec::with_capacity(source.len());
            let mut chars = source.chars().peekable();
            while let Some(c) = chars.next() {
                if c == '\r' {
                    // CR LF and CR are each one line break (b-break [28]).
                    if chars.peek() == Some(&'\n') {
                        chars.next();
                    }
                    s.push('\n');
                } else {
                    s.push(c);
                }
            }
            let mut lines = vec![0];
            lines.extend(s.iter().enumerate().filter(|(_, c)| **c == '\n').map(|(i, _)| i + 1));
            Reader { s, lines, pos: 0, b: Builder::default(), frames: Vec::new() }
        }

        fn at(&self, i: usize) -> char {
            self.s.get(i).copied().unwrap_or(END)
        }

        fn end(&self) -> bool {
            self.pos >= self.s.len()
        }

        fn line_start(&self, i: usize) -> usize {
            self.lines[self.lines.partition_point(|&start| start <= i) - 1]
        }

        fn col(&self, i: usize) -> usize {
            i - self.line_start(i)
        }

        fn position(&self, i: usize) -> (usize, usize) {
            let line = self.lines.partition_point(|&start| start <= i);
            (line, i - self.lines[line - 1] + 1)
        }

        /// Whether the line that starts at `i` starts with the marker `---` or `...` (`c-forbidden` [206]).
        fn marker(&self, i: usize, c: char) -> bool {
            (0..3).all(|k| self.at(i + k) == c) && white_or_eol(self.at(i + 3))
        }

        fn any_marker(&self, i: usize) -> bool {
            self.marker(i, '-') || self.marker(i, '.')
        }

        fn spaces(&self, i: usize) -> usize {
            let mut k = i;
            while self.at(k) == ' ' {
                k += 1;
            }
            k - i
        }

        fn skip_white(&self, mut i: usize) -> usize {
            while white(self.at(i)) {
                i += 1;
            }
            i
        }

        fn line_end(&self, mut i: usize) -> usize {
            while !eol(self.at(i)) {
                i += 1;
            }
            i
        }

        /// Skips comment lines and lines of white space from the start of a line (6.6); the reader stops at the start of
        /// the next line that holds anything else, or at the end of the stream.
        fn skip_comment_lines(&mut self) {
            loop {
                let i = self.skip_white(self.pos);
                match self.at(i) {
                    '\n' => self.pos = i + 1,
                    '#' => {
                        let e = self.line_end(i);
                        self.pos = if self.at(e) == '\n' { e + 1 } else { e };
                    }
                    END => {
                        self.pos = i;
                        return;
                    }
                    _ => return,
                }
            }
        }

        /// White space, an optional comment and the line break after a node or a marker (`s-l-comments` [79]).
        fn comment_to_eol(&mut self) -> Step<()> {
            let start = self.pos;
            self.pos = self.skip_white(self.pos);
            if self.at(self.pos) == '#' {
                if self.pos == start && start > 0 && ns_char(self.at(start - 1)) {
                    return Err(Refusal::Parse(self.pos));
                }
                self.pos = self.line_end(self.pos);
            }
            match self.at(self.pos) {
                '\n' => {
                    self.pos += 1;
                    Ok(())
                }
                END => Ok(()),
                _ => Err(Refusal::Parse(self.pos)),
            }
        }

        // ---- the stream ----

        /// `l-yaml-stream` [211]: document prefixes and end markers, the one document, and what may follow it (COD-75).
        fn stream(&mut self) -> Step<()> {
            loop {
                self.skip_comment_lines();
                if self.end() {
                    return rule("no document");
                }
                if !self.marker(self.pos, '.') {
                    break;
                }
                self.pos += 3;
                self.comment_to_eol()?;
            }
            if self.at(self.pos) == '%' {
                self.directives()?;
                if !self.marker(self.pos, '-') {
                    return Err(Refusal::Parse(self.pos));
                }
            }
            self.frames.push(Frame::Root);
            let next = if self.marker(self.pos, '-') {
                self.pos += 3;
                Next::Block { n: -1, ctx: BlockCtx::In, inline: Inline::DocStart }
            } else {
                Next::Block { n: -1, ctx: BlockCtx::In, inline: Inline::LineStart }
            };
            self.run(next)
        }

        /// The directives of the document (6.8), each at the start of a line, then the comment lines before `---`.
        fn directives(&mut self) -> Step<()> {
            let mut yaml = false;
            let mut handles: Vec<String> = Vec::new();
            while self.at(self.pos) == '%' {
                let start = self.pos;
                let mut i = start + 1;
                while ns_char(self.at(i)) {
                    i += 1;
                }
                let name: String = self.s[start + 1..i].iter().collect();
                match name.as_str() {
                    "YAML" => {
                        if yaml || !white(self.at(i)) {
                            return Err(Refusal::Parse(if yaml { start } else { i }));
                        }
                        let version = self.skip_white(i);
                        let mut e = version;
                        while ns_char(self.at(e)) {
                            e += 1;
                        }
                        // A version other than 1.2 is refused (COD-75).
                        if self.s[version..e].iter().collect::<String>() != "1.2" {
                            return Err(Refusal::Parse(version));
                        }
                        yaml = true;
                        self.pos = e;
                    }
                    "TAG" => {
                        if !white(self.at(i)) {
                            return Err(Refusal::Parse(i));
                        }
                        let handle_start = self.skip_white(i);
                        let handle_end = self.tag_handle(handle_start)?;
                        let handle: String = self.s[handle_start..handle_end].iter().collect();
                        if handles.contains(&handle) {
                            return Err(Refusal::Parse(handle_start));
                        }
                        handles.push(handle);
                        if !white(self.at(handle_end)) {
                            return Err(Refusal::Parse(handle_end));
                        }
                        self.pos = self.tag_prefix(self.skip_white(handle_end))?;
                    }
                    // A reserved directive (ns-reserved-directive [83]) is refused (COD-75).
                    _ => return Err(Refusal::Parse(start)),
                }
                self.comment_to_eol()?;
                self.skip_comment_lines();
            }
            Ok(())
        }

        /// `c-tag-handle` [89]: `!`, `!!` or `!` word characters `!`; returns its end.
        fn tag_handle(&self, i: usize) -> Step<usize> {
            if self.at(i) != '!' {
                return Err(Refusal::Parse(i));
            }
            let mut k = i + 1;
            while self.at(k).is_ascii_alphanumeric() || self.at(k) == '-' {
                k += 1;
            }
            if self.at(k) == '!' {
                Ok(k + 1)
            } else if k == i + 1 {
                Ok(k)
            } else {
                Err(Refusal::Parse(k))
            }
        }

        /// `ns-tag-prefix` [93]: a local prefix `!` or a global one that starts with a tag character, then URI
        /// characters; returns its end.
        fn tag_prefix(&self, i: usize) -> Step<usize> {
            let mut k = match self.at(i) {
                '!' => i + 1,
                first if flow_indicator(first) => return Err(Refusal::Parse(i)),
                _ => self.uri_char(i).ok_or(Refusal::Parse(i))?,
            };
            while let Some(next) = self.uri_char(k) {
                k = next;
            }
            Ok(k)
        }

        /// `ns-uri-char` [39] at `i`: returns the index after it.
        fn uri_char(&self, i: usize) -> Option<usize> {
            let c = self.at(i);
            if c == '%' {
                return (self.at(i + 1).is_ascii_hexdigit() && self.at(i + 2).is_ascii_hexdigit()).then_some(i + 3);
            }
            (c.is_ascii_alphanumeric() || "-#;/?:@&=+$,_.!~*'()[]".contains(c)).then_some(i + 1)
        }

        // ---- the main loop ----

        fn run(&mut self, mut next: Next) -> Step<()> {
            loop {
                next = match next {
                    Next::Block { n, ctx, inline } => self.block_node(n, ctx, inline)?,
                    Next::Flow { n, ctx } => self.flow_node(n, ctx)?,
                    Next::Resume => self.resume()?,
                    Next::Done => return Ok(()),
                };
            }
        }

        fn set(&mut self, frame: Frame) {
            if let Some(top) = self.frames.last_mut() {
                *top = frame;
            }
        }

        fn close(&mut self) -> Step<Next> {
            self.frames.pop();
            self.b.close();
            Ok(Next::Resume)
        }

        fn resume(&mut self) -> Step<Next> {
            match self.frames.last().copied() {
                Some(Frame::Root) | None => self.root_resume(),
                Some(Frame::BlockSeq { col }) => self.seq_resume(col),
                Some(Frame::BlockMap { col, phase }) => self.map_resume(col, phase),
                Some(Frame::FlowInBlock) => {
                    self.comment_to_eol()?;
                    self.frames.pop();
                    Ok(Next::Resume)
                }
                Some(Frame::Detached) => Err(Refusal::Parse(self.pos)),
                Some(Frame::FlowSeq { n, ctx, phase }) => self.flow_seq_resume(n, ctx, phase),
                Some(Frame::FlowMap { n, ctx, phase }) => self.flow_map_resume(n, ctx, phase),
                Some(Frame::FlowPair { n, ctx, phase }) => self.flow_pair_resume(n, ctx, phase),
            }
        }

        /// After the node of the document: the end of the stream, a document end marker, or a second document, which is
        /// met where it starts and of which nothing is read (COD-75).
        fn root_resume(&mut self) -> Step<Next> {
            self.skip_comment_lines();
            if self.end() {
                return Ok(Next::Done);
            }
            if self.marker(self.pos, '-') {
                return rule(DOCUMENTS);
            }
            if !self.marker(self.pos, '.') {
                return Err(Refusal::Parse(self.pos + self.spaces(self.pos)));
            }
            loop {
                self.pos += 3;
                self.comment_to_eol()?;
                self.skip_comment_lines();
                if self.end() {
                    return Ok(Next::Done);
                }
                if !self.marker(self.pos, '.') {
                    return rule(DOCUMENTS);
                }
            }
        }

        // ---- block nodes ----

        /// `s-l+block-node(n,c)` [196] and `s-l+block-indented(n,c)` [185]: a node on the line of its indicator, on the
        /// next lines, or the empty node.
        fn block_node(&mut self, n: isize, ctx: BlockCtx, inline: Inline) -> Step<Next> {
            if inline != Inline::LineStart {
                let mut tab = false;
                while white(self.at(self.pos)) {
                    tab |= self.at(self.pos) == '\t';
                    self.pos += 1;
                }
                if self.at(self.pos) == '#' {
                    self.pos = self.line_end(self.pos);
                }
                if !eol(self.at(self.pos)) {
                    return self.node_here(n, inline, tab);
                }
                if self.at(self.pos) == '\n' {
                    self.pos += 1;
                }
            }
            self.skip_comment_lines();
            if self.end() || self.any_marker(self.pos) {
                self.b.null()?;
                return Ok(Next::Resume);
            }
            let m = self.spaces(self.pos);
            let c = self.at(self.pos + m);
            if c == '\t' {
                // A tab ends the indentation: only a flow node or a block scalar starts after it (COD-76).
                if m as isize > n {
                    self.pos = self.skip_white(self.pos + m);
                    return self.node_here(n, Inline::LineStart, true);
                }
            } else if m as isize > n {
                self.pos += m;
                return self.node_here(n, Inline::LineStart, false);
            } else if m as isize == n && ctx == BlockCtx::Out && c == '-' && white_or_eol(self.at(self.pos + m + 1)) {
                // A sequence that is the value of a key may stand at the indentation of the key (seq-space [201]).
                self.pos += m;
                return self.open_block_seq();
            }
            self.b.null()?;
            Ok(Next::Resume)
        }

        /// A block node that starts at the reader: properties, a block scalar, a block collection or a flow node.
        fn node_here(&mut self, n: isize, inline: Inline, tab: bool) -> Step<Next> {
            let c = self.at(self.pos);
            match c {
                '&' => return rule("anchors are not supported"),
                '!' => return rule("explicit tags are not supported"),
                '*' => return rule("aliases are not supported"),
                '|' | '>' => {
                    self.block_scalar(n)?;
                    return Ok(Next::Resume);
                }
                _ => {}
            }
            // A block collection starts a line, after spaces only, or is compact on the line of an indicator (COD-76).
            let collection = !tab && matches!(inline, Inline::LineStart | Inline::Indicator);
            let next = self.at(self.pos + 1);
            if c == '-' && white_or_eol(next) {
                return if collection { self.open_block_seq() } else { Err(Refusal::Parse(self.pos)) };
            }
            if c == '?' && white_or_eol(next) {
                if !collection {
                    return Err(Refusal::Parse(self.pos));
                }
                return self.open_block_map();
            }
            if collection && self.key_ahead(self.pos, false) {
                return self.open_block_map();
            }
            self.frames.push(Frame::FlowInBlock);
            Ok(Next::Flow { n: n + 1, ctx: FlowCtx::Out })
        }

        fn open_block_seq(&mut self) -> Step<Next> {
            let col = self.col(self.pos);
            self.b.open(false)?;
            self.frames.push(Frame::BlockSeq { col });
            self.pos += 1;
            Ok(Next::Block { n: col as isize, ctx: BlockCtx::In, inline: Inline::Indicator })
        }

        fn open_block_map(&mut self) -> Step<Next> {
            let col = self.col(self.pos);
            self.b.open(true)?;
            self.frames.push(Frame::BlockMap { col, phase: MapPhase::Value });
            self.map_entry(col)
        }

        /// An entry of a block mapping at the reader, which is at the column of the mapping: `?`, `:` or an implicit
        /// key ([188]).
        fn map_entry(&mut self, col: usize) -> Step<Next> {
            let c = self.at(self.pos);
            let next = self.at(self.pos + 1);
            if c == '?' && white_or_eol(next) {
                self.pos += 1;
                self.set(Frame::BlockMap { col, phase: MapPhase::ExplicitKey });
                return Ok(Next::Block { n: col as isize, ctx: BlockCtx::Out, inline: Inline::Indicator });
            }
            if c == ':' && white_or_eol(next) {
                // An empty key is the empty plain scalar, a null (COD-76).
                self.b.null()?;
                self.pos += 1;
                self.set(Frame::BlockMap { col, phase: MapPhase::Value });
                return Ok(Next::Block { n: col as isize, ctx: BlockCtx::Out, inline: Inline::ImplicitValue });
            }
            if self.key_ahead(self.pos, false) {
                self.set(Frame::BlockMap { col, phase: MapPhase::ImplicitKey });
            } else {
                self.b.slots.push(Slot::Detached);
                self.frames.push(Frame::Detached);
            }
            Ok(Next::Flow { n: col as isize + 1, ctx: FlowCtx::BlockKey })
        }

        fn map_resume(&mut self, col: usize, phase: MapPhase) -> Step<Next> {
            match phase {
                MapPhase::ImplicitKey => {
                    self.pos = self.skip_white(self.pos);
                    if self.at(self.pos) != ':' || !white_or_eol(self.at(self.pos + 1)) {
                        return Err(Refusal::Parse(self.pos));
                    }
                    self.pos += 1;
                    self.set(Frame::BlockMap { col, phase: MapPhase::Value });
                    Ok(Next::Block { n: col as isize, ctx: BlockCtx::Out, inline: Inline::ImplicitValue })
                }
                MapPhase::ExplicitKey => {
                    self.set(Frame::BlockMap { col, phase: MapPhase::Value });
                    self.skip_comment_lines();
                    if !self.end() && !self.any_marker(self.pos) {
                        let m = self.spaces(self.pos);
                        let value = self.pos + m;
                        if m == col && self.at(value) == ':' && white_or_eol(self.at(value + 1)) {
                            self.pos = value + 1;
                            return Ok(Next::Block { n: col as isize, ctx: BlockCtx::Out, inline: Inline::Indicator });
                        }
                    }
                    // An entry with no `:` line has a null value (COD-76).
                    self.b.null()?;
                    self.map_next(col)
                }
                MapPhase::Value => self.map_next(col),
            }
        }

        /// After the comment lines that follow a node of a block collection at column `col`: the indentation of the next
        /// line when it is at that column, `None` when the collection ends there (the end of the text, a document marker
        /// or a line indented less), and a refusal when the line is indented more.
        fn next_at_column(&mut self, col: usize) -> Step<Option<usize>> {
            self.skip_comment_lines();
            if self.end() || self.any_marker(self.pos) {
                return Ok(None);
            }
            let m = self.spaces(self.pos);
            if m < col {
                return Ok(None);
            }
            if m > col {
                return Err(Refusal::Parse(self.pos + m));
            }
            Ok(Some(m))
        }

        /// After an entry: the next entry at the column of the mapping, or the end of the mapping.
        fn map_next(&mut self, col: usize) -> Step<Next> {
            let Some(m) = self.next_at_column(col)? else {
                return self.close();
            };
            self.pos += m;
            self.map_entry(col)
        }

        fn seq_resume(&mut self, col: usize) -> Step<Next> {
            let Some(m) = self.next_at_column(col)? else {
                return self.close();
            };
            let dash = self.pos + m;
            if self.at(dash) == '-' && white_or_eol(self.at(dash + 1)) {
                self.pos = dash + 1;
                return Ok(Next::Block { n: col as isize, ctx: BlockCtx::In, inline: Inline::Indicator });
            }
            self.close()
        }

        // ---- block scalars ----

        /// A literal or folded block scalar ([162] to [182]) whose parent is at indentation `n` (COD-78); the reader ends
        /// at the start of the line after its content.
        fn block_scalar(&mut self, n: isize) -> Step<()> {
            let folded = self.at(self.pos) == '>';
            let mut i = self.pos + 1;
            let mut indent: Option<usize> = None;
            let mut chomp: Option<char> = None;
            for _ in 0..2 {
                let c = self.at(i);
                if indent.is_none() && ('1'..='9').contains(&c) {
                    indent = Some(c as usize - '0' as usize);
                } else if chomp.is_none() && (c == '-' || c == '+') {
                    chomp = Some(c);
                } else {
                    break;
                }
                i += 1;
            }
            // The header ends with white space and a comment or nothing before its line break (s-b-comment [77]).
            self.pos = i;
            let header = self.skip_white(i);
            if self.at(header) == '#' {
                if header == i {
                    return Err(Refusal::Parse(header));
                }
                self.pos = self.line_end(header);
            } else {
                self.pos = header;
            }
            match self.at(self.pos) {
                '\n' => self.pos += 1,
                END => {}
                _ => return Err(Refusal::Parse(self.pos)),
            }
            let content_indent = match indent {
                Some(d) => (n + d as isize).max(0) as usize,
                None => match self.detect_indent(n)? {
                    Some(m) => m,
                    // No line of content: every line up to the end of the scalar is empty.
                    None => usize::MAX,
                },
            };
            // Each line of the scalar: its text after the content indentation, whether it is empty, and whether a line
            // break ends it.
            let mut lines: Vec<(String, bool, bool)> = Vec::new();
            loop {
                let start = self.pos;
                if start >= self.s.len() {
                    break;
                }
                let s = self.spaces(start);
                let e = self.line_end(start);
                if s >= content_indent {
                    if content_indent == 0 && self.any_marker(start) {
                        break;
                    }
                    let text: String = self.s[start + content_indent..e].iter().collect();
                    let empty = text.is_empty();
                    lines.push((text, empty, self.at(e) == '\n'));
                } else if start + s == e {
                    if self.at(e) == END {
                        // Spaces at the end of the stream with no line break: no line of the scalar.
                        self.pos = e;
                        break;
                    }
                    lines.push((String::new(), true, true));
                } else {
                    break;
                }
                self.pos = if self.at(e) == '\n' { e + 1 } else { e };
            }
            let last = lines.iter().rposition(|(_, empty, _)| !empty);
            let mut text = String::new();
            let mut final_break = false;
            let trailing = match last {
                None => &lines[..],
                Some(k) => {
                    let body = &lines[..=k];
                    if folded {
                        Self::fold(body, &mut text);
                    } else {
                        for (index, (line, _, _)) in body.iter().enumerate() {
                            if index > 0 {
                                text.push('\n');
                            }
                            text.push_str(line);
                        }
                    }
                    final_break = body[k].2;
                    &lines[k + 1..]
                }
            };
            match chomp {
                Some('-') => {}
                Some(_) => {
                    if final_break {
                        text.push('\n');
                    }
                    text.extend(trailing.iter().filter(|(_, _, broken)| *broken).map(|_| '\n'));
                }
                None => {
                    if final_break {
                        text.push('\n');
                    }
                }
            }
            self.b.scalar(text, false)
        }

        /// The content indentation of a block scalar without an indentation indicator: the spaces of its first line that
        /// is not empty, which is more than the indentation of its parent, or None when no such line follows (8.1.1.1).
        /// A leading empty line with more spaces than that line is `yaml-parse` (Example 8.3).
        fn detect_indent(&self, n: isize) -> Step<Option<usize>> {
            let mut i = self.pos;
            let mut widest: Option<(usize, usize)> = None;
            while i < self.s.len() {
                let s = self.spaces(i);
                let e = self.line_end(i);
                if i + s != e {
                    if (s as isize) <= n || (s == 0 && self.any_marker(i)) {
                        return Ok(None);
                    }
                    if let Some((_, at)) = widest.filter(|(spaces, _)| *spaces > s) {
                        return Err(Refusal::Parse(at + s));
                    }
                    return Ok(Some(s));
                }
                if widest.is_none_or(|(spaces, _)| s > spaces) {
                    widest = Some((s, i));
                }
                if self.at(e) != '\n' {
                    break;
                }
                i = e + 1;
            }
            Ok(None)
        }

        /// Folds the lines of a folded scalar (6.5, [175] to [181]): between two lines whose text starts with no white
        /// space a line break is one space, or k line feeds before k empty lines; around a more-indented line each line
        /// break is kept.
        fn fold(body: &[(String, bool, bool)], text: &mut String) {
            let mut lines = body.iter().peekable();
            while let Some((_, true, _)) = lines.peek() {
                text.push('\n');
                lines.next();
            }
            let more = |line: &str| line.starts_with([' ', '\t']);
            let mut previous: Option<bool> = None;
            let mut empties = 0;
            for (line, empty, _) in lines {
                if *empty {
                    empties += 1;
                    continue;
                }
                let indented = more(line);
                if let Some(previous_indented) = previous {
                    if !previous_indented && !indented {
                        if empties == 0 {
                            text.push(' ');
                        }
                        text.extend(std::iter::repeat_n('\n', empties));
                    } else {
                        text.extend(std::iter::repeat_n('\n', empties + 1));
                    }
                }
                text.push_str(line);
                previous = Some(indented);
                empties = 0;
            }
        }

        // ---- flow nodes ----

        /// A flow node at the reader ([156] to [161]): properties, a flow collection, a quoted scalar or a plain one.
        fn flow_node(&mut self, n: isize, ctx: FlowCtx) -> Step<Next> {
            let c = self.at(self.pos);
            match c {
                '&' => rule("anchors are not supported"),
                '!' => rule("explicit tags are not supported"),
                '*' => rule("aliases are not supported"),
                '[' | '{' => {
                    self.b.open(c == '{')?;
                    self.pos += 1;
                    let inner = ctx.inner();
                    self.frames.push(if c == '[' {
                        Frame::FlowSeq { n, ctx: inner, phase: FlowPhase::Open }
                    } else {
                        Frame::FlowMap { n, ctx: inner, phase: FlowPhase::Open }
                    });
                    Ok(Next::Resume)
                }
                '\'' | '"' => {
                    let (end, text) = if c == '\'' { self.single(self.pos, n, ctx.multi_line())? } else { self.double(self.pos, n, ctx.multi_line())? };
                    self.pos = end;
                    self.b.scalar(text, false)?;
                    Ok(Next::Resume)
                }
                _ => {
                    if !self.plain_first(self.pos, ctx.flow()) {
                        return Err(Refusal::Parse(self.pos));
                    }
                    let (end, text) = self.plain(self.pos, n, ctx.flow(), ctx.multi_line(), usize::MAX);
                    self.pos = end;
                    self.b.scalar(text, true)?;
                    Ok(Next::Resume)
                }
            }
        }

        /// Separation inside a flow collection (`s-separate(n,c)` [80]): white space, comments and, unless the
        /// collection is a key on one line, line breaks with lines indented by at least `n` spaces.
        fn flow_sep(&mut self, n: isize, ctx: FlowCtx) -> Step<()> {
            loop {
                let start = self.pos;
                self.pos = self.skip_white(self.pos);
                if self.at(self.pos) == '#' {
                    if self.pos == start && start > 0 && ns_char(self.at(start - 1)) {
                        // A `#` that follows another character starts no comment; the caller refuses it.
                        return Ok(());
                    }
                    self.pos = self.line_end(self.pos);
                }
                if self.at(self.pos) != '\n' || !ctx.multi_line() {
                    return Ok(());
                }
                self.pos += 1;
                loop {
                    let line = self.pos;
                    let m = self.spaces(line);
                    let j = self.skip_white(line + m);
                    match self.at(j) {
                        '\n' => self.pos = j + 1,
                        '#' => {
                            self.pos = self.line_end(j);
                            if self.at(self.pos) == '\n' {
                                self.pos += 1;
                            }
                        }
                        END => {
                            self.pos = j;
                            return Ok(());
                        }
                        _ => {
                            if m == 0 && self.any_marker(line) {
                                return Err(Refusal::Parse(line));
                            }
                            if (m as isize) < n {
                                return Err(Refusal::Parse(line + m));
                            }
                            self.pos = j;
                            break;
                        }
                    }
                }
            }
        }

        fn flow_seq_resume(&mut self, n: isize, ctx: FlowCtx, phase: FlowPhase) -> Step<Next> {
            self.flow_sep(n, ctx)?;
            let c = self.at(self.pos);
            if phase != FlowPhase::Open {
                return match c {
                    ',' => {
                        self.pos += 1;
                        self.set(Frame::FlowSeq { n, ctx, phase: FlowPhase::Open });
                        Ok(Next::Resume)
                    }
                    ']' => {
                        self.pos += 1;
                        self.close()
                    }
                    _ => Err(Refusal::Parse(self.pos)),
                };
            }
            match c {
                ']' => {
                    self.pos += 1;
                    return self.close();
                }
                // A `,` with no entry before it (COD-77).
                ',' => return Err(Refusal::Parse(self.pos)),
                _ => {}
            }
            self.set(Frame::FlowSeq { n, ctx, phase: FlowPhase::Entry });
            if c == '?' && white_or_eol(self.at(self.pos + 1)) {
                self.b.open(true)?;
                self.pos += 1;
                self.frames.push(Frame::FlowPair { n, ctx, phase: FlowPhase::Explicit });
                return Ok(Next::Resume);
            }
            if self.key_ahead(self.pos, true) {
                // An entry `k: v` is a map of that one pair (ns-flow-pair [150]).
                self.b.open(true)?;
                self.frames.push(Frame::FlowPair { n, ctx, phase: FlowPhase::Key { json: json_start(c) } });
                if self.empty_key(self.pos) {
                    self.b.null()?;
                    return Ok(Next::Resume);
                }
                return Ok(Next::Flow { n, ctx: FlowCtx::Key });
            }
            Ok(Next::Flow { n, ctx })
        }

        /// A `:` with no key before it: the empty key, a null ([144]).
        fn empty_key(&self, i: usize) -> bool {
            self.at(i) == ':' && !plain_safe(self.at(i + 1), true)
        }

        fn flow_pair_resume(&mut self, n: isize, ctx: FlowCtx, phase: FlowPhase) -> Step<Next> {
            match phase {
                FlowPhase::Explicit => {
                    self.flow_sep(n, ctx)?;
                    let c = self.at(self.pos);
                    if c == ']' || c == ',' {
                        // `?` with neither key nor value (e-node e-node).
                        self.b.null()?;
                        self.b.null()?;
                        self.frames.pop();
                        self.b.close();
                        return Ok(Next::Resume);
                    }
                    self.set(Frame::FlowPair { n, ctx, phase: FlowPhase::Key { json: json_start(c) } });
                    if self.empty_key(self.pos) {
                        self.b.null()?;
                        return Ok(Next::Resume);
                    }
                    Ok(Next::Flow { n, ctx })
                }
                FlowPhase::Key { json } => {
                    self.flow_sep(n, ctx)?;
                    let c = self.at(self.pos);
                    if c == ':' && (json || !plain_safe(self.at(self.pos + 1), true)) {
                        self.pos += 1;
                        self.set(Frame::FlowPair { n, ctx, phase: FlowPhase::Value });
                        return self.flow_value(n, ctx, json);
                    }
                    if c == ',' || c == ']' {
                        self.b.null()?;
                        self.frames.pop();
                        self.b.close();
                        return Ok(Next::Resume);
                    }
                    Err(Refusal::Parse(self.pos))
                }
                _ => {
                    self.frames.pop();
                    self.b.close();
                    Ok(Next::Resume)
                }
            }
        }

        fn flow_map_resume(&mut self, n: isize, ctx: FlowCtx, phase: FlowPhase) -> Step<Next> {
            self.flow_sep(n, ctx)?;
            let c = self.at(self.pos);
            match phase {
                FlowPhase::Key { json } => {
                    if c == ':' && (json || !plain_safe(self.at(self.pos + 1), true)) {
                        self.pos += 1;
                        self.set(Frame::FlowMap { n, ctx, phase: FlowPhase::Value });
                        return self.flow_value(n, ctx, json);
                    }
                    if c == ',' || c == '}' {
                        // A key alone, whose value is a null (COD-77).
                        self.b.null()?;
                        self.set(Frame::FlowMap { n, ctx, phase: FlowPhase::Value });
                        return Ok(Next::Resume);
                    }
                    Err(Refusal::Parse(self.pos))
                }
                FlowPhase::Value | FlowPhase::Entry | FlowPhase::Explicit => match c {
                    ',' => {
                        self.pos += 1;
                        self.set(Frame::FlowMap { n, ctx, phase: FlowPhase::Open });
                        Ok(Next::Resume)
                    }
                    '}' => {
                        self.pos += 1;
                        self.close()
                    }
                    _ => Err(Refusal::Parse(self.pos)),
                },
                FlowPhase::Open => {
                    match c {
                        '}' => {
                            self.pos += 1;
                            return self.close();
                        }
                        ',' => return Err(Refusal::Parse(self.pos)),
                        _ => {}
                    }
                    let mut c = c;
                    if c == '?' && white_or_eol(self.at(self.pos + 1)) {
                        self.pos += 1;
                        self.flow_sep(n, ctx)?;
                        c = self.at(self.pos);
                        if c == '}' || c == ',' {
                            // `?` with neither key nor value (e-node e-node).
                            self.b.null()?;
                            self.b.null()?;
                            self.set(Frame::FlowMap { n, ctx, phase: FlowPhase::Value });
                            return Ok(Next::Resume);
                        }
                    }
                    self.set(Frame::FlowMap { n, ctx, phase: FlowPhase::Key { json: json_start(c) } });
                    if self.empty_key(self.pos) {
                        self.b.null()?;
                        return Ok(Next::Resume);
                    }
                    // Every node that starts an entry of a flow mapping is its key (COD-80).
                    Ok(Next::Flow { n, ctx })
                }
            }
        }

        /// The value after the `:` of a flow entry: after a key that is a flow collection or a quoted scalar it may be
        /// adjacent ([148]); after another key it is separated by white space or a line break, or it is the empty node
        /// ([147]).
        fn flow_value(&mut self, n: isize, ctx: FlowCtx, json: bool) -> Step<Next> {
            if !json && !white_or_eol(self.at(self.pos)) {
                self.b.null()?;
                return Ok(Next::Resume);
            }
            self.flow_sep(n, ctx)?;
            if matches!(self.at(self.pos), ',' | ']' | '}') {
                self.b.null()?;
                return Ok(Next::Resume);
            }
            Ok(Next::Flow { n, ctx })
        }

        // ---- scalars ----

        /// `ns-plain-first(c)` [126].
        fn plain_first(&self, i: usize, flow: bool) -> bool {
            let c = self.at(i);
            ns_char(c) && (!indicator(c) || (matches!(c, '-' | '?' | ':') && plain_safe(self.at(i + 1), flow)))
        }

        /// The rest of a line of a plain scalar whose character at `i` is a plain character (`nb-ns-plain-in-line`
        /// [133]); returns the index after its last character that is not white space, or a value past `limit`.
        fn plain_line(&self, i: usize, flow: bool, text: &mut String, limit: usize) -> usize {
            text.push(self.at(i));
            let mut end = i + 1;
            loop {
                if end > limit {
                    return end;
                }
                let j = self.skip_white(end);
                let c = self.at(j);
                let plain = match c {
                    _ if eol(c) => false,
                    // A `#` that follows white space starts a comment.
                    '#' => j == end,
                    ':' => plain_safe(self.at(j + 1), flow),
                    _ => !(flow && flow_indicator(c)),
                };
                if !plain {
                    return end;
                }
                text.extend(&self.s[end..=j]);
                end = j + 1;
            }
        }

        /// A plain scalar at `i` ([131] to [135]); on several lines unless it is a key, each line indented by at least
        /// `n` spaces, folded (6.5). Returns the index after its last character that is not white space.
        fn plain(&self, i: usize, n: isize, flow: bool, multi_line: bool, limit: usize) -> (usize, String) {
            let mut text = String::new();
            let mut end = self.plain_line(i, flow, &mut text, limit);
            if !multi_line {
                return (end, text);
            }
            loop {
                let j = self.skip_white(end);
                if self.at(j) != '\n' {
                    return (end, text);
                }
                let Ok((empties, t)) = self.after_break(j + 1, n) else {
                    return (end, text);
                };
                let c = self.at(t);
                let plain = match c {
                    '#' => false,
                    ':' => plain_safe(self.at(t + 1), flow),
                    _ => !(flow && flow_indicator(c)),
                };
                if !plain {
                    return (end, text);
                }
                if empties == 0 {
                    text.push(' ');
                }
                text.extend(std::iter::repeat_n('\n', empties));
                end = self.plain_line(t, flow, &mut text, limit);
            }
        }

        /// A line break inside a quoted scalar at `i` ([73], [113], [124]): the empty lines after it are line feeds, and
        /// the break is one space unless it is escaped or empty lines follow it. The next line is indented by at least
        /// `n` spaces. Returns the index of the next character of the scalar.
        fn quoted_break(&self, i: usize, n: isize, text: &mut String, escaped: bool) -> Step<usize> {
            let (empties, t) = self.after_break(i + 1, n).map_err(Refusal::Parse)?;
            if empties == 0 && !escaped {
                text.push(' ');
            }
            text.extend(std::iter::repeat_n('\n', empties));
            Ok(t)
        }

        /// The lines after a line break, from the start of the line at `k`: the number of empty lines (white space only)
        /// and the index of the first character of the next line that is indented by at least `n` spaces. It is the index
        /// that ends the scalar when the next line that is not empty is indented less, when the text ends, or when that
        /// line starts with a document marker.
        fn after_break(&self, mut k: usize, n: isize) -> std::result::Result<(usize, usize), usize> {
            let mut empties = 0;
            loop {
                let line = k;
                let s = self.spaces(line);
                if (s as isize) < n {
                    if self.at(line + s) == '\n' {
                        empties += 1;
                        k = line + s + 1;
                        continue;
                    }
                    return Err(line + s);
                }
                let t = self.skip_white(line + s);
                match self.at(t) {
                    '\n' => {
                        empties += 1;
                        k = t + 1;
                        continue;
                    }
                    END => return Err(t),
                    _ => {}
                }
                if s == 0 && self.any_marker(line) {
                    return Err(line);
                }
                return Ok((empties, t));
            }
        }

        /// A single-quoted scalar at `i` ([117] to [125]); returns the index after its closing quote and its string.
        fn single(&self, i: usize, n: isize, multi_line: bool) -> Step<(usize, String)> {
            self.quoted(i, n, multi_line, |c, k, text| {
                Ok(match c {
                    '\'' if self.at(k + 1) == '\'' => {
                        text.push('\'');
                        Quoted::Next(k + 2)
                    }
                    '\'' => Quoted::Close,
                    _ => Quoted::Content,
                })
            })
        }

        /// A double-quoted scalar at `i` ([107] to [116]) with the escapes of 5.7; returns the index after its closing
        /// quote and its string.
        fn double(&self, i: usize, n: isize, multi_line: bool) -> Step<(usize, String)> {
            self.quoted(i, n, multi_line, |c, k, text| {
                Ok(match c {
                    '"' => Quoted::Close,
                    // The white space before a `\` is content (s-double-escaped [112]).
                    '\\' => Quoted::Next(self.double_escape(k, n, multi_line, text)?),
                    _ => Quoted::Content,
                })
            })
        }

        /// The escape at `k` of a double-quoted scalar (5.7), written to `text`; returns the index after it.
        fn double_escape(&self, k: usize, n: isize, multi_line: bool, text: &mut String) -> Step<usize> {
            let e = self.at(k + 1);
            let simple = match e {
                '0' => Some('\0'),
                'a' => Some('\u{7}'),
                'b' => Some('\u{8}'),
                't' | '\t' => Some('\t'),
                'n' => Some('\n'),
                'v' => Some('\u{b}'),
                'f' => Some('\u{c}'),
                'r' => Some('\r'),
                'e' => Some('\u{1b}'),
                ' ' => Some(' '),
                '"' => Some('"'),
                '/' => Some('/'),
                '\\' => Some('\\'),
                'N' => Some('\u{85}'),
                '_' => Some('\u{a0}'),
                'L' => Some('\u{2028}'),
                'P' => Some('\u{2029}'),
                _ => None,
            };
            if let Some(escaped) = simple {
                text.push(escaped);
                return Ok(k + 2);
            }
            let digits = match e {
                'x' => 2,
                'u' => 4,
                'U' => 8,
                '\n' if multi_line => return self.quoted_break(k + 1, n, text, true),
                _ => return Err(Refusal::Parse(k + 1)),
            };
            let mut code: u32 = 0;
            for d in 0..digits {
                let Some(value) = self.at(k + 2 + d).to_digit(16) else {
                    return Err(Refusal::Parse(k + 2 + d));
                };
                code = code * 16 + value;
            }
            // A surrogate or a number above U+10FFFF is no Unicode scalar value (COD-78).
            let Some(escaped) = char::from_u32(code) else {
                return Err(Refusal::Parse(k));
            };
            text.push(escaped);
            Ok(k + 2 + digits)
        }

        /// The loop that a single-quoted and a double-quoted scalar at `i` share: a line break folds (or is refused when
        /// the scalar is on one line), white space before a line break is dropped, and any other character is content
        /// after the white space before it. `own` reads a character at `k` that the style gives a meaning, after that
        /// white space is in `text`: its closing quote, a doubled quote or an escape. Returns the index after the closing
        /// quote and the string.
        fn quoted(&self, i: usize, n: isize, multi_line: bool, own: impl Fn(char, usize, &mut String) -> Step<Quoted>) -> Step<(usize, String)> {
            let mut text = String::new();
            let mut white_run = String::new();
            let mut k = i + 1;
            loop {
                let c = self.at(k);
                match c {
                    END => return Err(Refusal::Parse(k)),
                    '\n' => {
                        if !multi_line {
                            return Err(Refusal::Parse(k));
                        }
                        white_run.clear();
                        k = self.quoted_break(k, n, &mut text, false)?;
                    }
                    ' ' | '\t' => {
                        white_run.push(c);
                        k += 1;
                    }
                    _ => {
                        text.push_str(&white_run);
                        white_run.clear();
                        match own(c, k, &mut text)? {
                            Quoted::Content => {
                                text.push(c);
                                k += 1;
                            }
                            Quoted::Next(next) => k = next,
                            Quoted::Close => return Ok((k + 1, text)),
                        }
                    }
                }
            }
        }

        // ---- implicit keys ----

        /// Whether the node at `i` is an implicit key (COD-80): the reader reads ahead over the node on its line, and it
        /// is a key when a `:` follows it within 1024 characters of its start, then white space or the end of the line
        /// in a block mapping (`flow` false), or a character that a plain scalar of a flow collection does not hold in a
        /// flow sequence. A node over which the read ahead leaves the grammar is no key.
        fn key_ahead(&self, i: usize, flow: bool) -> bool {
            let follows = |c: char| if flow { !plain_safe(c, true) } else { white_or_eol(c) };
            if self.at(i) == ':' && follows(self.at(i + 1)) {
                return true;
            }
            let limit = i + KEY_LIMIT;
            let Some((end, json)) = self.skim(i, flow, limit) else {
                return false;
            };
            let colon = self.skip_white(end);
            colon <= limit && self.at(colon) == ':' && ((flow && json) || follows(self.at(colon + 1)))
        }

        /// Reads over the node at `i` on its line without building it (`flow-key` or `block-key`); returns its end and
        /// whether it is a flow collection or a quoted scalar, or None where the node leaves the grammar or the line or
        /// passes `limit`. It keeps the open flow collections on its own stack.
        fn skim(&self, i: usize, flow: bool, limit: usize) -> Option<(usize, bool)> {
            #[derive(Clone, Copy, PartialEq, Eq)]
            enum Ph {
                Open,
                Node,
                Value,
            }
            let mut stack: Vec<(char, Ph)> = Vec::new();
            let mut k = i;
            let mut json = false;
            let mut want_node = true;
            loop {
                if k > limit {
                    return None;
                }
                if want_node {
                    want_node = false;
                    let in_flow = flow || !stack.is_empty();
                    // Properties, which the reader refuses where it meets them, are read over here.
                    let mut properties = false;
                    let mut alias = false;
                    loop {
                        match self.at(k) {
                            '&' | '*' => {
                                alias = self.at(k) == '*';
                                let name = k + 1;
                                k = name;
                                while plain_safe(self.at(k), true) && k <= limit {
                                    k += 1;
                                }
                                if k == name {
                                    return None;
                                }
                            }
                            '!' => {
                                k += 1;
                                if self.at(k) == '<' {
                                    while self.at(k) != '>' {
                                        if eol(self.at(k)) || k > limit {
                                            return None;
                                        }
                                        k += 1;
                                    }
                                    k += 1;
                                } else {
                                    while plain_safe(self.at(k), true) && k <= limit {
                                        k += 1;
                                    }
                                }
                            }
                            _ => break,
                        }
                        properties = true;
                        if alias {
                            break;
                        }
                        if !white(self.at(k)) {
                            break;
                        }
                        k = self.skip_white(k);
                    }
                    let c = self.at(k);
                    json = false;
                    if alias {
                        // An alias is the whole node.
                    } else if c == '[' || c == '{' {
                        stack.push((if c == '[' { ']' } else { '}' }, Ph::Open));
                        k += 1;
                        continue;
                    } else if c == '\'' || c == '"' {
                        let scanned = if c == '\'' { self.single(k, 0, false) } else { self.double(k, 0, false) };
                        let Ok((end, _)) = scanned else {
                            return None;
                        };
                        k = end;
                        json = true;
                    } else if self.plain_first(k, in_flow) {
                        let mut text = String::new();
                        k = self.plain_line(k, in_flow, &mut text, limit);
                    } else if !properties {
                        return None;
                    }
                    if stack.is_empty() {
                        return Some((k, json));
                    }
                    continue;
                }
                let Some(&(close, phase)) = stack.last() else {
                    return Some((k, json));
                };
                k = self.skip_white(k);
                let c = self.at(k);
                let top = stack.len() - 1;
                match phase {
                    Ph::Open => {
                        if c == close {
                            k += 1;
                            stack.pop();
                            json = true;
                            if stack.is_empty() {
                                return Some((k, true));
                            }
                            continue;
                        }
                        if c == ',' || !ns_char(c) || c == '#' {
                            return None;
                        }
                        if c == '?' && white_or_eol(self.at(k + 1)) {
                            k = self.skip_white(k + 1);
                            if matches!(self.at(k), ']' | '}' | ',') {
                                stack[top].1 = Ph::Value;
                                continue;
                            }
                        }
                        stack[top].1 = Ph::Node;
                        if self.empty_key(k) {
                            json = false;
                        } else {
                            want_node = true;
                        }
                    }
                    Ph::Node => {
                        stack[top].1 = Ph::Value;
                        if c == ':' && (json || !plain_safe(self.at(k + 1), true)) {
                            k += 1;
                            if !json && !white(self.at(k)) {
                                continue;
                            }
                            k = self.skip_white(k);
                            if !matches!(self.at(k), ',' | ']' | '}') {
                                want_node = true;
                            }
                        }
                    }
                    Ph::Value => {
                        if c == ',' {
                            k += 1;
                            stack[top].1 = Ph::Open;
                        } else if c == close {
                            k += 1;
                            stack.pop();
                            json = true;
                            if stack.is_empty() {
                                return Some((k, true));
                            }
                        } else {
                            return None;
                        }
                    }
                }
            }
        }
    }
}

// ---- PHP serialize format ----

/// Writes a value at `level` in the PHP serialize format, in the order of its text: a list or a map at level 257 is
/// `serialize-depth-write` before its members, so the recursion holds at most 257 calls (COD-70).
fn php_serialize(out: &mut String, v: &Value, level: usize) -> Result<()> {
    if matches!(v, Value::Array(_) | Value::Object(_)) && level > NESTING_LEVELS {
        return Err(err(CODEC_ENCODE, "serialize: value nesting exceeds 256 levels"));
    }
    match v {
        Value::Null => out.push_str("N;"),
        Value::Bool(b) => out.push_str(if *b { "b:1;" } else { "b:0;" }),
        Value::Number(n) => {
            // An integer beyond i64 is outside the common value model (COD-16), though serde_json gives it as an f64 too.
            match (n.as_i64(), n.as_f64()) {
                (Some(i), _) => out.push_str(&format!("i:{i};")),
                (None, Some(f)) if n.is_f64() => out.push_str(&format!("d:{};", php_float(f))),
                _ => return Err(err(CODEC_ENCODE, "serialize: integer is outside the i64 range")),
            }
        }
        Value::String(s) => out.push_str(&format!("s:{}:\"{}\";", s.len(), s)),
        Value::Array(items) => {
            out.push_str(&format!("a:{}:{{", items.len()));
            for (i, e) in items.iter().enumerate() {
                out.push_str(&format!("i:{i};"));
                php_serialize(out, e, level + 1)?;
            }
            out.push('}');
        }
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            out.push_str(&format!("a:{}:{{", m.len()));
            for k in keys {
                match php_int_key(k) {
                    Some(n) => out.push_str(&format!("i:{n};")),
                    None => out.push_str(&format!("s:{}:\"{}\";", k.len(), k)),
                }
                php_serialize(out, &m[k], level + 1)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// PHP's array-key normalization: canonical decimal integers become int keys.
fn php_int_key(k: &str) -> Option<i64> {
    if k.is_empty() || k == "-0" || (k.len() > 1 && k.starts_with('0')) || (k.len() > 2 && k.starts_with("-0")) {
        return None;
    }
    // A canonical decimal that does not fit i64 stays a string key, as PHP keeps it.
    let Ok(value) = k.parse::<i64>() else {
        return None;
    };
    Some(value)
}

/// Like PHP's serialize_precision=-1: shortest round-trip, integral values
/// without a fraction ("d:2;"), exponent form as "1.0E+25" (same cut-offs as Go).
fn php_float(f: f64) -> String {
    if f.is_infinite() {
        return if f > 0.0 { "INF".into() } else { "-INF".into() };
    }
    if f.is_nan() {
        return "NAN".into();
    }
    let sci = format!("{f:e}"); // shortest mantissa, e.g. "1.5e25", "2e0", "1e-7"
    let (mant, exp) = sci.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    // PHP writes the shortest digits (serialize_precision -1) in the exponent form when the decimal exponent is below -4
    // or above 16, and in fixed notation otherwise (zend_gcvt with precision 17).
    if (-4..=16).contains(&exp) {
        return format!("{f}"); // Display: "2", "0.1", "1.5", "10000000000000000"
    }
    let mant = if mant.contains('.') { mant.to_string() } else { format!("{mant}.0") };
    format!("{mant}E{}{}", if exp < 0 { "-" } else { "+" }, exp.abs())
}

/// Reads a PHP serialize cell without recursion: the arrays that are open are a stack, so a cell nested to any depth is
/// read on a stack of a fixed size, and the `a` field at level 257 is `serialize-depth` before its length (COD-70).
fn php_unserialize(b: &[u8]) -> Result<Value> {
    let mut p = Parser { b, i: 0 };
    let mut open: Vec<PhpArray> = Vec::new();
    loop {
        let at_key = open.last().is_some_and(|array| array.key.is_none());
        let mut node = match p.node(open.len() + 1, at_key)? {
            PhpNode::Scalar(value) => Some(value),
            PhpNode::Array(len) => {
                open.push(PhpArray::new(len));
                None
            }
        };
        // Places the node in the array that holds it, and closes each array whose members are all read.
        loop {
            if let Some(value) = node.take() {
                match open.last_mut() {
                    Some(array) => array.place(value).map_err(|msg| p.fail(msg))?,
                    None => {
                        if p.i != b.len() {
                            return Err(p.fail("trailing data"));
                        }
                        return Ok(value);
                    }
                }
            }
            match open.last() {
                Some(array) if array.is_complete() => {
                    p.expect(b'}')?;
                    node = open.pop().map(PhpArray::into_value);
                }
                _ => break,
            }
        }
    }
}

/// A node of a serialize cell: a scalar value, or the start of an array of that many members.
enum PhpNode {
    Scalar(Value),
    Array(usize),
}

/// An array that the reader is reading: its length, its members so far, the key of the member that comes next, the keys
/// it has met, and whether its keys so far are 0, 1, 2, ... in order, which makes it a list.
struct PhpArray {
    len: usize,
    keys: Vec<String>,
    vals: Vec<Value>,
    seen: std::collections::HashSet<String>,
    key: Option<String>,
    sequential: bool,
}

impl PhpArray {
    fn new(len: usize) -> Self {
        Self { len, keys: Vec::new(), vals: Vec::new(), seen: std::collections::HashSet::new(), key: None, sequential: true }
    }

    fn is_complete(&self) -> bool {
        self.key.is_none() && self.vals.len() == self.len
    }

    /// Places a key or a member: a key is an integer, by its decimal string, or a string, and a key that repeats an
    /// earlier one is `serialize-duplicate` where it repeats (COD-70).
    fn place(&mut self, value: Value) -> std::result::Result<(), &'static str> {
        if let Some(key) = self.key.take() {
            self.keys.push(key);
            self.vals.push(value);
            return Ok(());
        }
        let key = match (value.as_i64(), value) {
            (Some(i), Value::Number(_)) => {
                // A key is sequential when it is the position of its member, which a usize holds and so fits i64.
                if i64::try_from(self.vals.len()) != Ok(i) {
                    self.sequential = false;
                }
                i.to_string()
            }
            (_, Value::String(s)) => {
                self.sequential = false;
                s
            }
            _ => return Err("array key must be int or string"),
        };
        if !self.seen.insert(key.clone()) {
            return Err("duplicate array key");
        }
        self.key = Some(key);
        Ok(())
    }

    fn into_value(self) -> Value {
        if self.sequential {
            return Value::Array(self.vals);
        }
        Value::Object(self.keys.into_iter().zip(self.vals).collect())
    }
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

/// The `d` field of the PHP grammar: an optional sign, digits with an optional fraction or a fraction alone, and an optional
/// exponent (COD-70 `serialize-float`).
static PHP_FLOAT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\A[-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?\z").unwrap());

impl<'a> Parser<'a> {
    /// The refusal of the rule `msg`, which names no offset (COD-70).
    fn fail(&self, msg: &str) -> Error {
        err(CODEC_DECODE, format!("serialize: {msg}"))
    }

    /// The refusal of the rule `msg`, keeping the failure that found it (COD-71).
    fn fail_cause(&self, msg: &str, cause: impl std::error::Error + Send + Sync + 'static) -> Error {
        err_cause(CODEC_DECODE, format!("serialize: {msg}"), cause)
    }

    fn expect(&mut self, c: u8) -> Result<()> {
        if self.b.get(self.i) != Some(&c) {
            return Err(self.fail(&format!("expected {}", c as char)));
        }
        self.i += 1;
        Ok(())
    }

    /// The bytes up to the delimiter `c`, which ends the field and is consumed.
    fn until(&mut self, c: u8) -> Result<&'a [u8]> {
        let rest = &self.b[self.i..];
        let j = rest.iter().position(|&x| x == c).ok_or_else(|| self.fail(&format!("expected {}", c as char)))?;
        self.i += j + 1;
        Ok(&rest[..j])
    }

    /// A field of the rule `msg` as text: a field that is not UTF-8 holds a byte that its grammar does not, so it breaks
    /// that rule.
    fn field(&mut self, c: u8, msg: &str) -> Result<&'a str> {
        let field = self.until(c)?;
        std::str::from_utf8(field).map_err(|error| self.fail_cause(msg, error))
    }

    /// A string or array length: digits only, without a sign (COD-70 `serialize-string-length`, `serialize-array-length`).
    fn length(&mut self, msg: &str) -> Result<usize> {
        let field = self.field(b':', msg)?;
        if field.is_empty() || !field.bytes().all(|b| b.is_ascii_digit()) {
            return Err(self.fail(msg));
        }
        field.parse().map_err(|error| self.fail_cause(msg, error))
    }

    /// Reads the node at `level`; `at_key` tells that it is an array key, which an array is not, so an `a` key is refused
    /// where it starts, after the nesting rule of its level (COD-70).
    fn node(&mut self, level: usize, at_key: bool) -> Result<PhpNode> {
        let t = *self.b.get(self.i).ok_or_else(|| self.fail("unexpected end"))?;
        self.i += 1;
        if t == b'a' {
            if level > NESTING_LEVELS {
                return Err(self.fail("value nesting exceeds 256 levels"));
            }
            if at_key {
                return Err(self.fail("array key must be int or string"));
            }
            self.expect(b':')?;
            let n = self.length("bad array length")?;
            self.expect(b'{')?;
            return Ok(PhpNode::Array(n));
        }
        self.scalar(t).map(PhpNode::Scalar)
    }

    /// The scalar of type `t`, whose type byte is read.
    fn scalar(&mut self, t: u8) -> Result<Value> {
        match t {
            b'N' => {
                self.expect(b';')?;
                Ok(Value::Null)
            }
            b'b' => {
                self.expect(b':')?;
                match self.field(b';', "bad bool")? {
                    "0" => Ok(Value::Bool(false)),
                    "1" => Ok(Value::Bool(true)),
                    _ => Err(self.fail("bad bool")),
                }
            }
            b'i' => {
                self.expect(b':')?;
                let s = self.field(b';', "bad int")?;
                s.parse::<i64>().map(Value::from).map_err(|error| match error.kind() {
                    std::num::IntErrorKind::PosOverflow | std::num::IntErrorKind::NegOverflow => self.fail_cause("integer is outside the i64 range", error),
                    _ => self.fail_cause("bad int", error),
                })
            }
            b'd' => {
                self.expect(b':')?;
                let s = self.field(b';', "bad float")?;
                let f = match s {
                    "INF" | "-INF" | "NAN" => return Err(self.fail("non-finite float")),
                    _ if !PHP_FLOAT.is_match(s) => return Err(self.fail("bad float")),
                    _ => s.parse::<f64>().map_err(|error| self.fail_cause("bad float", error))?,
                };
                // A float beyond the f64 range reads as infinite, which the common value model does not hold (COD-16).
                serde_json::Number::from_f64(f).map(Value::Number).ok_or_else(|| self.fail("non-finite float"))
            }
            b's' => {
                self.expect(b':')?;
                let n = self.length("bad string length")?;
                self.expect(b'"')?;
                if n > self.b.len() - self.i {
                    return Err(self.fail("string overruns input"));
                }
                let s = String::from_utf8(self.b[self.i..self.i + n].to_vec()).map_err(|error| self.fail_cause("string is not valid UTF-8", error))?;
                self.i += n;
                self.expect(b'"')?;
                self.expect(b';')?;
                Ok(Value::String(s))
            }
            b'O' | b'C' | b'r' | b'R' => Err(err(CODEC_UNSUPPORTED, "serialize: objects and references are not supported")),
            _ => Err(self.fail("unknown type")),
        }
    }
}

/// A positional column with executor-side stages: the codec stages (docs/spec/codec.md) and the
/// host stages a dialect left to us (aes/hex/ip); on read, host runs before codec.
pub struct StyledCol {
    pub index: usize,
    pub codec: Vec<String>,
    pub host: Vec<String>,
}

/// Positional columns of a step that need decoding (joins included).
pub fn styled_cols(a: &crate::plan::Assemble) -> Vec<StyledCol> {
    let mut out = Vec::new();
    for c in &a.columns {
        if !c.styles.is_empty() {
            let (codec, host) = split_host(&c.styles);
            out.push(StyledCol { index: c.index, codec, host });
        }
    }
    for ch in &a.children {
        if let Some(ja) = &ch.assemble {
            out.extend(styled_cols(ja));
        }
    }
    out
}

/// Separates the codec stages from the host stages (aes/hex/ip), each in write order.
pub fn split_host(styles: &[String]) -> (Vec<String>, Vec<String>) {
    let (host, codec): (Vec<String>, Vec<String>) = styles.iter().cloned().partition(|s| is_host(s));
    (codec, host)
}

fn is_host(style: &str) -> bool {
    matches!(style, "aes" | "hex" | "ip" | "blind_index")
}

/// Refuses a style that is no host stage, `blind_index` included, before the value or the cell is read (COD-70
/// `host-style`).
fn check_host_styles(styles: &[String]) -> Result<()> {
    match styles.iter().find(|st| !matches!(st.as_str(), "aes" | "hex" | "ip")) {
        Some(other) => Err(err(CODEC_UNSUPPORTED, format!("host style {other}"))),
        None => Ok(()),
    }
}

/// Returns the stages the executor codec applies, in write order. `aes`, `hex`, and `ip` are host stages.
pub fn executor_stages(stages: &[String]) -> Vec<&str> {
    stages.iter().map(String::as_str).filter(|s| !is_host(s)).collect()
}

// ---- host stages (docs/spec/dialects.md): what MySQL does in SQL, PostgreSQL/SQLite leave to the executor ----

use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit as GcmKeyInit, Nonce,
};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

const AES_V2_PREFIX: &[u8] = b"ORM-AES2\0";

/// Returns the stable lowercase HMAC-SHA256 index for plaintext.
pub fn blind_index(v: &Param, key: &str) -> Result<String> {
    if key.is_empty() {
        return Err(Error::Config("secret blind_index not configured".into()));
    }
    let plain = match v {
        Param::Null => return Ok(String::new()),
        Param::Str(s) => s.as_bytes().to_vec(),
        Param::Bytes(b) => b.clone(),
        _ => return Err(err(CODEC_ENCODE, "blind index input must be text or bytes")),
    };
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key.as_bytes()).expect("HMAC takes a key of any length");
    mac.update(&plain);
    Ok(hex_upper(&mac.finalize().into_bytes()).to_ascii_lowercase())
}

fn aes_v2_key(key: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"polyspec/orm/aes-256-gcm/v2\0");
    h.update(key.as_bytes());
    h.finalize().into()
}

/// The text of `aes-encrypt` (COD-70): the cipher or the random source failed.
const AES_ENCRYPT_FAILED: &str = "aes: the encryption failed";

/// Returns the authenticated v2 envelope used by every client. A failure of the random source or of the cipher is
/// `aes-encrypt` with the failure as its cause (COD-71).
pub fn aes_encrypt(plain: &[u8], key: &str) -> Result<Vec<u8>> {
    use rand::TryRng as _;
    let cipher = Aes256Gcm::new_from_slice(&aes_v2_key(key)).map_err(|error| err_cause(CODEC_ENCODE, AES_ENCRYPT_FAILED, error))?;
    let mut nonce = [0u8; 12];
    rand::rngs::SysRng.try_fill_bytes(&mut nonce).map_err(|error| err_cause(CODEC_ENCODE, AES_ENCRYPT_FAILED, error))?;
    let nonce = Nonce::from(nonce);
    let encrypted = cipher.encrypt(&nonce, Payload { msg: plain, aad: AES_V2_PREFIX }).map_err(|error| err_cause(CODEC_ENCODE, AES_ENCRYPT_FAILED, error))?;
    Ok([AES_V2_PREFIX, &nonce, &encrypted].concat())
}

/// Authenticates and decrypts a v2 envelope.
pub fn aes_decrypt(cipher_text: &[u8], key: &str) -> Result<Vec<u8>> {
    if !cipher_text.starts_with(AES_V2_PREFIX) {
        return Err(err(CODEC_DECODE, "aes: unsupported ciphertext format"));
    }
    if cipher_text.len() < AES_V2_PREFIX.len() + 12 + 16 {
        return Err(err(CODEC_DECODE, "aes: truncated v2 envelope"));
    }
    let offset = AES_V2_PREFIX.len();
    // Any failure of the decryption is `aes-auth` (COD-70), with the failure as its cause.
    let cipher = Aes256Gcm::new_from_slice(&aes_v2_key(key)).map_err(|error| err_cause(CODEC_DECODE, "aes: authentication failed", error))?;
    let nonce: [u8; 12] = cipher_text[offset..offset + 12].try_into().map_err(|error| err_cause(CODEC_DECODE, "aes: authentication failed", error))?;
    let nonce = Nonce::from(nonce);
    cipher
        .decrypt(&nonce, Payload { msg: &cipher_text[offset + 12..], aad: AES_V2_PREFIX })
        .map_err(|error| err_cause(CODEC_DECODE, "aes: authentication failed", error))
}

/// Upper-case hex text, the form every encoder writes.
pub fn hex_upper(b: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    let mut s = String::with_capacity(b.len() * 2);
    for &x in b {
        s.push(DIGITS[(x >> 4) as usize] as char);
        s.push(DIGITS[(x & 15) as usize] as char);
    }
    s
}

/// The message of a refused `hex` cell, the same text in every client (COD-39).
const HEX_REFUSED: &str = "hex: odd length or non-hex input";

/// Reads the upper-case hex text that `hex_upper` writes. The
/// text is decoded exactly: a lower-case letter, white space or any other byte
/// outside the upper-case hex digits is `CODEC_DECODE` (docs/spec/codec.md).
pub fn hex_decode(s: &str) -> Result<Vec<u8>> {
    hex_bytes(s.as_bytes())
}

/// The bytes of upper-case hex text; every refusal states the one text of COD-39.
fn hex_bytes(s: &[u8]) -> Result<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return Err(err(CODEC_DECODE, HEX_REFUSED));
    }
    let nibble = |c: u8| -> Result<u8> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err(err(CODEC_DECODE, HEX_REFUSED)),
        }
    };
    s.as_chunks::<2>().0.iter().map(|p| Ok(nibble(p[0])? << 4 | nibble(p[1])?)).collect()
}

/// `INET6_ATON`: 4 bytes for IPv4, 16 for IPv6.
fn pack_ip(s: &str) -> Result<Vec<u8>> {
    // The exact text only: white space around the address is CODEC_ENCODE (docs/spec/codec.md).
    match s.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(a)) => Ok(a.octets().to_vec()),
        Ok(std::net::IpAddr::V6(a)) => Ok(a.octets().to_vec()),
        Err(_) => Err(err(CODEC_ENCODE, "ip: the text is not an address")),
    }
}

/// `INET6_NTOA`.
fn unpack_ip(b: &[u8]) -> Result<String> {
    match b.len() {
        4 => Ok(std::net::Ipv4Addr::from(<[u8; 4]>::try_from(b).unwrap()).to_string()),
        16 => Ok(std::net::Ipv6Addr::from(<[u8; 16]>::try_from(b).unwrap()).to_string()),
        _ => Err(err(CODEC_DECODE, "ip: the cell is not 4 or 16 packed bytes")),
    }
}

/// Applies the host stages of a bound value in write order (`bind_slots[].host_styles`).
/// The result binds as text after `hex`, as bytes otherwise; NULL stays NULL.
pub fn host_encode(v: &Param, styles: &[String], aes_key: &str) -> Result<Param> {
    if styles.is_empty() {
        return Err(err(CODEC_ENCODE, "host style list is empty"));
    }
    check_host_styles(styles)?;
    let mut cur = match v {
        Param::Null => return Ok(Param::Null),
        Param::Str(s) => Written::Bytes(s.as_bytes().to_vec()),
        Param::Bytes(b) => Written::Bytes(b.clone()),
        // A host stage takes text or bytes only (COD-1).
        _ => return Err(err(CODEC_ENCODE, "host input must be text or bytes")),
    };
    for st in styles {
        cur = match st.as_str() {
            "aes" => {
                if aes_key.is_empty() {
                    return Err(Error::Config("secret aes not configured".into()));
                }
                Written::Bytes(aes_encrypt(&cur.into_bytes(), aes_key)?)
            }
            "hex" => Written::Text(hex_upper(&cur.into_bytes())),
            // Bytes that are not UTF-8 are no text of an address (COD-70 `ip-text`).
            _ => Written::Bytes(pack_ip(
                &String::from_utf8(cur.into_bytes()).map_err(|error| err_cause(CODEC_ENCODE, "ip: the text is not an address", error))?,
            )?),
        };
    }
    // The result binds as text after `hex`, as bytes otherwise.
    Ok(match cur {
        Written::Text(text) => Param::Str(text),
        Written::Bytes(bytes) => Param::Bytes(bytes),
    })
}

/// Undoes `host_encode` on a read cell (styles in write order, applied in reverse):
/// text when the bytes are UTF-8, bytes otherwise, the address text after `ip`.
pub fn host_decode(raw: &Val, styles: &[String], aes_key: &str) -> Result<Val> {
    check_host_styles(styles)?;
    let mut cur: Vec<u8> = match raw {
        Val::Null => return Ok(Val::Null),
        Val::Str(s) => s.as_bytes().to_vec(),
        Val::Bytes(b) => b.clone(),
        _ => return Err(err(CODEC_DECODE, "cell is not bytes")),
    };
    for st in styles.iter().rev() {
        cur = match st.as_str() {
            // A byte that is not ASCII is no hex digit, so bytes that are not UTF-8 are refused with the same text.
            "hex" => hex_bytes(&cur)?,
            "aes" => {
                if aes_key.is_empty() {
                    return Err(Error::Config("secret aes not configured".into()));
                }
                aes_decrypt(&cur, aes_key)?
            }
            _ => return Ok(Val::Str(unpack_ip(&cur)?)),
        };
    }
    Ok(match String::from_utf8(cur) {
        Ok(s) => Val::Str(s),
        Err(e) => Val::Bytes(e.into_bytes()),
    })
}

#[cfg(test)]
#[path = "../tests/unit/codec_tests.rs"]
mod tests;
