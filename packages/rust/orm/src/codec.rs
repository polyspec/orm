//! Column-style codecs (docs/spec/codec.md): ordered_json, serialize, base64, gz, yaml.
//! Styles are listed in write order; `decode` applies them in reverse. A first `gz` or
//! `base64` stage takes a string value and stores its UTF-8 text (docs/spec/codec.md, Stage lists).

use std::io::{Read, Write};
use std::sync::LazyLock;

use base64::Engine as _;
use granit_parser::{
    ErrorKind as YamlErrorKind, Event as YamlEvent, Parser as YamlParser, ScalarStyle, Span as YamlSpan, TryLoadError, TrySpannedEventReceiver,
};
use ordered_json as strict_json;
use regex::Regex;
use serde_json::{Map, Value};

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
                    let text = if error.kind() == "maximum_depth_exceeded" { "json: value nesting exceeds 256 levels" } else { "json: the cell is not JSON" };
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

// ---- yaml: YAML 1.2 with the core schema: read through granit-parser, written by serde-saphyr ----

/// A collection the reader is building: a sequence, or a mapping with the key of the
/// value that comes next.
enum YamlFrame {
    Sequence(Vec<Value>),
    Mapping { map: Map<String, Value>, key: Option<String> },
}

/// Builds the common value of one YAML document from the parser events, and refuses
/// in the same pass every form that docs/spec/codec.md (yaml) refuses. The first refusal stops the parse.
#[derive(Default)]
struct YamlReader {
    documents: usize,
    frames: Vec<YamlFrame>,
    value: Option<Value>,
}

/// The refusal of the rule `message`, which names no position (COD-70), with the failure that found it, if any.
fn yaml_refusal(message: &str, source: Option<YamlCause>) -> Error {
    Error::Engine { code: CODEC_DECODE.into(), msg: format!("yaml: {message}"), source }
}

fn yaml_fail(message: &str) -> Result<()> {
    Err(yaml_refusal(message, None))
}

impl YamlReader {
    /// Whether the next node is a mapping key.
    fn at_key(&self) -> bool {
        matches!(self.frames.last(), Some(YamlFrame::Mapping { key: None, .. }))
    }

    /// Places a finished node: a mapping key, a mapping value, a sequence item, or the document.
    fn place(&mut self, value: Value) -> Result<()> {
        match self.frames.last_mut() {
            Some(YamlFrame::Sequence(items)) => items.push(value),
            Some(YamlFrame::Mapping { map, key }) => match key.take() {
                Some(name) => {
                    map.insert(name, value);
                }
                None => {
                    // A plain integer key becomes its decimal string; a quoted key is a string.
                    let name = match value {
                        Value::String(name) => name,
                        Value::Number(number) if number.is_i64() => number.to_string(),
                        _ => return yaml_fail("map keys must be strings or integers"),
                    };
                    if map.contains_key(&name) {
                        return yaml_fail("duplicate map key");
                    }
                    *key = Some(name);
                }
            },
            None => self.value = Some(value),
        }
        Ok(())
    }

    /// Opens a sequence or a mapping: its anchor and its tag first, then the nesting rule of its level, then the rule of
    /// a map key (COD-70).
    fn start_collection(&mut self, anchor: usize, tag: bool, frame: YamlFrame) -> Result<()> {
        if anchor != 0 {
            yaml_fail("anchors are not supported")
        } else if tag {
            yaml_fail("explicit tags are not supported")
        } else if self.frames.len() == NESTING_LEVELS {
            yaml_fail("value nesting exceeds 256 levels")
        } else if self.at_key() {
            yaml_fail("map keys must be scalar strings")
        } else {
            self.frames.push(frame);
            Ok(())
        }
    }
}

impl<'input> TrySpannedEventReceiver<'input> for YamlReader {
    type Error = Error;

    fn on_event(&mut self, event: YamlEvent<'input>, _span: YamlSpan) -> Result<()> {
        match event {
            YamlEvent::DocumentStart(..) => {
                self.documents += 1;
                if self.documents > 1 {
                    return yaml_fail("multiple documents are not supported");
                }
                Ok(())
            }
            YamlEvent::Alias(_) => yaml_fail("aliases are not supported"),
            YamlEvent::Scalar(text, style, anchor, tag) => {
                if anchor != 0 {
                    yaml_fail("anchors are not supported")
                } else if tag.is_some() {
                    yaml_fail("explicit tags are not supported")
                } else if style != ScalarStyle::Plain {
                    self.place(Value::String(text.into_owned()))
                } else {
                    match yaml_core_scalar(text.into_owned()) {
                        Ok(value) => self.place(value),
                        Err((message, source)) => Err(yaml_refusal(message, source)),
                    }
                }
            }
            YamlEvent::SequenceStart(_, anchor, tag) => self.start_collection(anchor, tag.is_some(), YamlFrame::Sequence(Vec::new())),
            YamlEvent::MappingStart(_, anchor, tag) => self.start_collection(anchor, tag.is_some(), YamlFrame::Mapping { map: Map::new(), key: None }),
            YamlEvent::SequenceEnd | YamlEvent::MappingEnd => match self.frames.pop() {
                Some(YamlFrame::Sequence(items)) => self.place(Value::Array(items)),
                Some(YamlFrame::Mapping { map, .. }) => self.place(Value::Object(map)),
                // granit-parser balances every end with its start, so no stream reaches this guard; it states yaml-parse,
                // with what it found as the cause (COD-72).
                None => Err(yaml_refusal("the stream does not parse", Some(Box::new(YamlReaderFault("a collection end without a start"))))),
            },
            // A comment is presentation, not a node; yaml_decode turns off its events, which the comments feature that
            // serde-saphyr enables would emit.
            YamlEvent::Comment(..) | YamlEvent::StreamStart | YamlEvent::StreamEnd | YamlEvent::DocumentEnd => Ok(()),
            // The event list of granit-parser is open to new kinds; a kind the reader does not know states yaml-parse,
            // with the event as the cause, rather than passing unread (COD-72).
            _ => Err(yaml_refusal("the stream does not parse", Some(Box::new(YamlReaderFault("an event the reader does not know"))))),
        }
    }
}

/// What a guard of the reader found that the parser should have refused; it is the cause of the yaml-parse error.
#[derive(Debug)]
struct YamlReaderFault(&'static str);

impl std::fmt::Display for YamlReaderFault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for YamlReaderFault {}

/// The failure that found a refused plain scalar.
type YamlCause = Box<dyn std::error::Error + Send + Sync + 'static>;
/// A refused plain scalar: the rule it breaks and the failure that found it, if any.
type YamlScalarRefusal = (&'static str, Option<YamlCause>);

static YAML_CORE_INT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\A(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)\z").unwrap());
static YAML_CORE_FLOAT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\A(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))\z").unwrap());

/// Resolves a plain scalar by the tags of the YAML 1.2 core schema (YAML 1.2.2, 10.3.2):
/// null, bool, int and float by their regular expressions, and str otherwise. granit-parser
/// reports a plain scalar as its text and resolves no tag, so the core schema is applied here. An integer
/// outside i64 and a float that is not finite are outside the common value model.
fn yaml_core_scalar(text: String) -> std::result::Result<Value, YamlScalarRefusal> {
    Ok(match text.as_str() {
        "" | "~" | "null" | "Null" | "NULL" => Value::Null,
        "true" | "True" | "TRUE" => Value::Bool(true),
        "false" | "False" | "FALSE" => Value::Bool(false),
        _ if YAML_CORE_INT.is_match(&text) => {
            let parsed = match (text.strip_prefix("0o"), text.strip_prefix("0x")) {
                (Some(digits), _) => i64::from_str_radix(digits, 8),
                (_, Some(digits)) => i64::from_str_radix(digits, 16),
                _ => text.parse::<i64>(),
            };
            Value::from(parsed.map_err(|error| ("integer is outside the i64 range", Some(Box::new(error) as YamlCause)))?)
        }
        _ if YAML_CORE_FLOAT.is_match(&text) => {
            // .inf and .nan are YAML floats that are not finite; Rust reads them without the dot.
            let float = match text.trim_start_matches(['+', '-']).strip_prefix('.') {
                Some(word) if word.eq_ignore_ascii_case("inf") || word.eq_ignore_ascii_case("nan") => return Err(("number is not finite", None)),
                // YAML_CORE_FLOAT admits only forms that Rust reads as f64, so no scalar reaches this guard; it states
                // yaml-parse, with the failure of the read as the cause (COD-72).
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

/// Whether a character may appear in a YAML stream (YAML 1.2.2, 5.1, c-printable). A byte order
/// mark is the encoding mark at the start of the stream (5.2) and never content.
fn yaml_printable(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\r' | ' '..='~' | '\u{85}' | '\u{a0}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..) && c != '\u{feff}'
}

/// Reads one YAML document into the common value model in one pass of the granit-parser events.
/// A stream without a document (empty, or comments only) is refused: an empty text is not a
/// YAML value. An explicit empty document (`---`) is null. Before parsing, the reader
/// removes a leading byte order mark and refuses a character outside c-printable.
fn yaml_decode(bytes: &[u8]) -> Result<Value> {
    let source = std::str::from_utf8(bytes).map_err(|error| err_cause(CODEC_DECODE, "yaml: the stream is not UTF-8", error))?;
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    if source.chars().any(|c| !yaml_printable(c)) {
        return Err(err(CODEC_DECODE, "yaml: the stream holds a character that is not printable"));
    }
    let mut reader = YamlReader::default();
    // The nesting limits of the library are lifted: the reader refuses a list or a map at level 257 by yaml-depth, as the
    // node starts, so no limit of the library decides a stream (COD-70).
    let options = granit_parser::options! { emit_comments: false, flow_nesting_limit: usize::MAX, block_nesting_limit: usize::MAX };
    match YamlParser::new_from_str_with_options(source, options).try_load(&mut reader, true) {
        // The reader meets the nodes of the document in their order and stops the parse at its first refusal, so a rule
        // that a node before the failure of the parse breaks is the error (COD-70).
        Err(TryLoadError::Receiver(error)) => Err(error),
        // granit-parser refuses an alias whose anchor is not in the stream before it reports the alias as an event.
        Err(TryLoadError::Scan(error)) if matches!(error.kind(), YamlErrorKind::UnknownAnchor) => {
            Err(err_cause(CODEC_DECODE, "yaml: aliases are not supported", error))
        }
        Err(TryLoadError::Scan(error)) => Err(err_cause(CODEC_DECODE, "yaml: the stream does not parse", error)),
        Ok(()) if reader.documents == 0 => Err(err(CODEC_DECODE, "yaml: no document")),
        Ok(()) => Ok(reader.value.unwrap_or(Value::Null)),
    }
}

/// Writes a common value as one YAML document with serde-saphyr, which quotes every string the
/// core schema would read as another value and escapes every character outside c-printable. A
/// number outside the common value model returns CODEC_ENCODE. The written text is read back, and
/// a text that does not read back as the value returns CODEC_ENCODE instead of storing it.
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
