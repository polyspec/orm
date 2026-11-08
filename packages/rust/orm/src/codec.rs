//! Column-style codecs (docs/spec/codec.md): ordered_json, serialize, base64, gz, yaml.
//! Styles are listed in write order; `decode` applies them in reverse. A first `gz` or
//! `base64` stage takes a string value and stores its UTF-8 text (docs/spec/codec.md, Stage lists).

use std::io::{Read, Write};
use std::sync::LazyLock;

use base64::Engine as _;
use ordered_json as strict_json;
use regex::Regex;
use saphyr_parser::{Event as YamlEvent, Marker as YamlMarker, Parser as YamlParser, ScalarStyle, Span as YamlSpan, SpannedEventReceiver};
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
    let mut value: Option<Val> = None;
    for st in styles.iter().rev() {
        if value.is_some() {
            return Err(err(CODEC_DECODE, format!("style {st} after a decoded value")));
        }
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
                value = Some(Val::Ordered(strict_json::parse_bytes(&cur).map_err(|error| err_cause(CODEC_DECODE, "json: the cell is not JSON", error))?))
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
        Some(&"ordered_json") => finish(&styles[1..], ordered_text(v).into_bytes()),
        // An ordered-json value is written by a first ordered_json stage only (COD-16).
        _ => Err(err(CODEC_ENCODE, "an ordered-json value is written by a first ordered_json stage only")),
    }
}

/// Applies the stages that follow a value stage (base64, gz) to encoded bytes.
fn finish(styles: &[&str], mut cur: Vec<u8>) -> Result<Param> {
    for st in styles {
        match *st {
            "base64" | "gz" => encode_binary_stage(st, &mut cur)?,
            "ordered_json" | "serialize" | "yaml" => return Err(err(CODEC_UNSUPPORTED, format!("{st} must be the first style"))),
            other => return Err(err(CODEC_UNSUPPORTED, format!("style {other}"))),
        }
    }
    encoded_cell(styles, cur)
}

/// The bind parameter of the encoded bytes: `Bytes` when the last stage is gz, otherwise text.
fn encoded_cell(styles: &[&str], bytes: Vec<u8>) -> Result<Param> {
    if styles.last() == Some(&"gz") {
        return Ok(Param::Bytes(bytes));
    }
    Ok(Param::Str(String::from_utf8(bytes).map_err(|e| err(CODEC_ENCODE, e.to_string()))?))
}

fn encode_binary_stage(style: &str, cur: &mut Vec<u8>) -> Result<()> {
    match style {
        "base64" => {
            *cur = base64::engine::general_purpose::STANDARD.encode(&*cur).into_bytes();
            Ok(())
        }
        "gz" => {
            let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
            enc.write_all(cur).map_err(|error| err_cause(CODEC_ENCODE, "gz: the compression failed", error))?;
            *cur = enc.finish().map_err(|error| err_cause(CODEC_ENCODE, "gz: the compression failed", error))?;
            Ok(())
        }
        other => Err(err(CODEC_UNSUPPORTED, format!("style {other}"))),
    }
}

/// Value → stored representation as a bind parameter (`Str`, or `Bytes` for gz).
pub fn encode(styles: &[&str], v: StyledValue<&Value>) -> Result<Param> {
    check_styles(styles.iter().copied())?;
    let StyledValue::Value(v) = v else { return Ok(Param::Null) };
    let mut cur: Vec<u8> = Vec::new();
    let value = v.clone();
    if takes_text(styles.first().copied()) {
        let Value::String(text) = &value else {
            let stage = styles.first().map_or("an empty stage list".to_owned(), |st| format!("a first {st} stage"));
            return Err(err(CODEC_ENCODE, format!("{stage} takes a string value")));
        };
        cur = text.clone().into_bytes();
    }
    for st in styles {
        match *st {
            "serialize" => {
                let mut s = String::new();
                number_check(&value, "serialize")?;
                php_serialize(&mut s, &value)?;
                cur = s.into_bytes();
            }
            "yaml" => {
                cur = yaml_encode(&value)?;
            }
            "ordered_json" => {
                let raw = serde_json::to_vec(&value).map_err(|error| err_cause(CODEC_ENCODE, "json: the value has no JSON text", error))?;
                let parsed = strict_json::parse_bytes(&raw).map_err(|error| err_cause(CODEC_ENCODE, "json: the value has no JSON text", error))?;
                cur = strict_json::stringify(&parsed).into_bytes();
            }
            "base64" | "gz" => encode_binary_stage(st, &mut cur)?,
            other => return Err(err(CODEC_UNSUPPORTED, format!("style {other}"))),
        }
    }
    encoded_cell(styles, cur)
}

// ---- yaml: YAML 1.2 with the core schema: read through saphyr-parser, written by serde-saphyr ----

/// A collection the reader is building: a sequence, or a mapping with the key of the
/// value that comes next.
enum YamlFrame {
    Sequence(Vec<Value>),
    Mapping { map: Map<String, Value>, key: Option<String> },
}

/// Builds the common value of one YAML document from the parser events, and refuses
/// in the same pass every form that docs/spec/codec.md (yaml) refuses.
#[derive(Default)]
struct YamlReader {
    documents: usize,
    frames: Vec<YamlFrame>,
    value: Option<Value>,
    error: Option<Error>,
}

impl YamlReader {
    fn fail(&mut self, mark: YamlMarker, message: impl AsRef<str>) {
        self.refuse(mark, message.as_ref(), None);
    }

    /// Keeps the first refusal of the stream: the rule with its line and column, and the failure that found it, if any.
    fn refuse(&mut self, mark: YamlMarker, message: &str, source: Option<Box<dyn std::error::Error + Send + Sync + 'static>>) {
        if self.error.is_none() {
            let msg = format!("yaml: {message} at line {}, column {}", mark.line(), mark.col());
            self.error = Some(Error::Engine { code: CODEC_DECODE.into(), msg, source });
        }
    }

    /// Whether the next node is a mapping key.
    fn at_key(&self) -> bool {
        matches!(self.frames.last(), Some(YamlFrame::Mapping { key: None, .. }))
    }

    /// Places a finished node: a mapping key, a mapping value, a sequence item, or the document.
    fn place(&mut self, value: Value, mark: YamlMarker) {
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
                        _ => return self.fail(mark, "plain boolean, null, and floating-point map keys are not supported"),
                    };
                    if map.contains_key(&name) {
                        return self.fail(mark, "duplicate map key");
                    }
                    *key = Some(name);
                }
            },
            None => self.value = Some(value),
        }
    }

    fn start_collection(&mut self, anchor: usize, tag: bool, frame: YamlFrame, mark: YamlMarker) {
        if anchor != 0 || tag {
            self.fail(mark, "anchors and explicit tags are not supported");
        } else if self.at_key() {
            self.fail(mark, "map keys must be scalar strings");
        } else {
            self.frames.push(frame);
        }
    }
}

impl<'input> SpannedEventReceiver<'input> for YamlReader {
    fn on_event(&mut self, event: YamlEvent<'input>, span: YamlSpan) {
        let mark = span.start;
        if self.error.is_some() {
            return;
        }
        match event {
            YamlEvent::DocumentStart(_) => {
                self.documents += 1;
                if self.documents > 1 {
                    self.fail(mark, "multiple documents are not supported");
                }
            }
            YamlEvent::Alias(_) => self.fail(mark, "aliases are not supported"),
            YamlEvent::Scalar(text, style, anchor, tag) => {
                if anchor != 0 {
                    self.fail(mark, "anchors are not supported");
                } else if tag.is_some() {
                    self.fail(mark, "explicit tags are not supported");
                } else if style != ScalarStyle::Plain {
                    self.place(Value::String(text.into_owned()), mark);
                } else {
                    match yaml_core_scalar(text.into_owned()) {
                        Ok(value) => self.place(value, mark),
                        Err((message, source)) => self.refuse(mark, message, source),
                    }
                }
            }
            YamlEvent::SequenceStart(anchor, tag) => self.start_collection(anchor, tag.is_some(), YamlFrame::Sequence(Vec::new()), mark),
            YamlEvent::MappingStart(anchor, tag) => self.start_collection(anchor, tag.is_some(), YamlFrame::Mapping { map: Map::new(), key: None }, mark),
            YamlEvent::SequenceEnd | YamlEvent::MappingEnd => match self.frames.pop() {
                Some(YamlFrame::Sequence(items)) => self.place(Value::Array(items), mark),
                Some(YamlFrame::Mapping { map, .. }) => self.place(Value::Object(map), mark),
                None => self.fail(mark, "collection end without a start"),
            },
            YamlEvent::Nothing | YamlEvent::StreamStart | YamlEvent::StreamEnd | YamlEvent::DocumentEnd => {}
        }
    }
}

/// The failure that found a refused plain scalar.
type YamlCause = Box<dyn std::error::Error + Send + Sync + 'static>;
/// A refused plain scalar: the rule it breaks and the failure that found it, if any.
type YamlScalarRefusal = (&'static str, Option<YamlCause>);

static YAML_CORE_INT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\A(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)\z").unwrap());
static YAML_CORE_FLOAT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\A(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))\z").unwrap());

/// Resolves a plain scalar by the tags of the YAML 1.2 core schema (YAML 1.2.2, 10.3.2):
/// null, bool, int and float by their regular expressions, and str otherwise. saphyr-parser
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
                _ => text.parse::<f64>().map_err(|error| ("float is not a number", Some(Box::new(error) as YamlCause)))?,
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

/// Reads one YAML document into the common value model in one pass of the saphyr-parser events.
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
    YamlParser::new_from_str(source).load(&mut reader, true).map_err(|error| err_cause(CODEC_DECODE, "yaml: the stream does not parse", error))?;
    match reader.error {
        Some(error) => Err(error),
        None if reader.documents == 0 => Err(err(CODEC_DECODE, "yaml: no document")),
        None => Ok(reader.value.unwrap_or(Value::Null)),
    }
}

/// Writes a common value as one YAML document with serde-saphyr, which quotes every string the
/// core schema would read as another value and escapes every character outside c-printable. A
/// number outside the common value model returns CODEC_ENCODE. The written text is read back, and
/// a text that does not read back as the value returns CODEC_ENCODE instead of storing it.
fn yaml_encode(value: &Value) -> Result<Vec<u8>> {
    number_check(value, "yaml")?;
    let text = serde_saphyr::to_string(value).map_err(|error| err_cause(CODEC_ENCODE, "yaml: the value has no YAML text", error))?;
    match yaml_decode(text.as_bytes()) {
        Ok(read) if read == *value => Ok(text.into_bytes()),
        // The text and the value are data, so the refusal names neither (INT-163).
        Ok(_) | Err(_) => Err(err(CODEC_ENCODE, "yaml: the written text does not read back as the value")),
    }
}

/// Refuses a number the common value model (COD-16) does not hold: an integer beyond i64.
fn number_check(value: &Value, style: &str) -> Result<()> {
    match value {
        Value::Number(number) if number.is_u64() && number.as_i64().is_none() => Err(err(CODEC_ENCODE, format!("{style}: integer is outside the i64 range"))),
        Value::Array(items) => items.iter().try_for_each(|item| number_check(item, style)),
        Value::Object(map) => map.values().try_for_each(|item| number_check(item, style)),
        _ => Ok(()),
    }
}

// ---- PHP serialize format ----

fn php_serialize(out: &mut String, v: &Value) -> Result<()> {
    match v {
        Value::Null => out.push_str("N;"),
        Value::Bool(b) => out.push_str(if *b { "b:1;" } else { "b:0;" }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                out.push_str(&format!("i:{i};"));
            } else if let Some(f) = n.as_f64() {
                out.push_str(&format!("d:{};", php_float(f)));
            } else {
                return Err(err(CODEC_ENCODE, "integer is outside the i64 range"));
            }
        }
        Value::String(s) => out.push_str(&format!("s:{}:\"{}\";", s.len(), s)),
        Value::Array(items) => {
            out.push_str(&format!("a:{}:{{", items.len()));
            for (i, e) in items.iter().enumerate() {
                out.push_str(&format!("i:{i};"));
                php_serialize(out, e)?;
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
                php_serialize(out, &m[k])?;
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

fn php_unserialize(b: &[u8]) -> Result<Value> {
    let mut p = Parser { b, i: 0 };
    let v = p.value()?;
    if p.i != b.len() {
        return Err(p.fail("trailing data"));
    }
    Ok(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn fail(&self, msg: &str) -> Error {
        err(CODEC_DECODE, format!("serialize: {msg} at {}", self.i))
    }

    /// The refusal `msg` at the offset, keeping the failure that found it.
    fn fail_cause(&self, msg: &str, cause: impl std::error::Error + Send + Sync + 'static) -> Error {
        err_cause(CODEC_DECODE, format!("serialize: {msg} at {}", self.i), cause)
    }

    fn expect(&mut self, c: u8) -> Result<()> {
        if self.b.get(self.i) != Some(&c) {
            return Err(self.fail(&format!("expected {}", c as char)));
        }
        self.i += 1;
        Ok(())
    }

    fn until(&mut self, c: u8) -> Result<&'a str> {
        let rest = &self.b[self.i..];
        let j = rest.iter().position(|&x| x == c).ok_or_else(|| self.fail(&format!("expected {}", c as char)))?;
        let s = std::str::from_utf8(&rest[..j]).map_err(|error| self.fail_cause("bad utf-8", error))?;
        self.i += j + 1;
        Ok(s)
    }

    fn value(&mut self) -> Result<Value> {
        let t = *self.b.get(self.i).ok_or_else(|| self.fail("unexpected end"))?;
        self.i += 1;
        match t {
            b'N' => {
                self.expect(b';')?;
                Ok(Value::Null)
            }
            b'b' | b'i' | b'd' => {
                self.expect(b':')?;
                let s = self.until(b';')?;
                match t {
                    b'b' => match s {
                        "0" => Ok(Value::Bool(false)),
                        "1" => Ok(Value::Bool(true)),
                        _ => Err(self.fail("bad boolean")),
                    },
                    b'i' => s.parse::<i64>().map(Value::from).map_err(|error| self.fail_cause("bad int", error)),
                    _ => {
                        let f = match s {
                            "INF" => f64::INFINITY,
                            "-INF" => f64::NEG_INFINITY,
                            "NAN" => f64::NAN,
                            _ => s.parse::<f64>().map_err(|error| self.fail_cause("bad float", error))?,
                        };
                        serde_json::Number::from_f64(f).map(Value::Number).ok_or_else(|| self.fail("non-finite float"))
                    }
                }
            }
            b's' => {
                self.expect(b':')?;
                let n: usize = self.until(b':')?.parse().map_err(|error| self.fail_cause("bad string length", error))?;
                self.expect(b'"')?;
                if self.i + n > self.b.len() {
                    return Err(self.fail("string overruns input"));
                }
                let s = String::from_utf8(self.b[self.i..self.i + n].to_vec()).map_err(|error| self.fail_cause("string is not utf-8", error))?;
                self.i += n;
                self.expect(b'"')?;
                self.expect(b';')?;
                Ok(Value::String(s))
            }
            b'a' => {
                self.expect(b':')?;
                let n: usize = self.until(b':')?.parse().map_err(|error| self.fail_cause("bad array length", error))?;
                self.expect(b'{')?;
                let mut keys: Vec<String> = Vec::with_capacity(n);
                let mut vals: Vec<Value> = Vec::with_capacity(n);
                let mut sequential = true;
                for k in 0..n {
                    let key = match self.value()? {
                        Value::Number(x) => {
                            let i = x.as_i64().ok_or_else(|| self.fail("bad key"))?;
                            if i != k as i64 {
                                sequential = false;
                            }
                            i.to_string()
                        }
                        Value::String(s) => {
                            sequential = false;
                            s
                        }
                        _ => return Err(self.fail("array key must be int or string")),
                    };
                    keys.push(key);
                    vals.push(self.value()?);
                }
                self.expect(b'}')?;
                if sequential {
                    return Ok(Value::Array(vals));
                }
                let mut m = Map::new();
                for (k, v) in keys.into_iter().zip(vals) {
                    m.insert(k, v);
                }
                Ok(Value::Object(m))
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

/// Returns the authenticated v2 envelope used by every client.
pub fn aes_encrypt(plain: &[u8], key: &str) -> Vec<u8> {
    let cipher = Aes256Gcm::new_from_slice(&aes_v2_key(key)).expect("AES-256 key");
    let nonce: [u8; 12] = rand::random();
    let nonce = Nonce::from(nonce);
    let encrypted = cipher.encrypt(&nonce, Payload { msg: plain, aad: AES_V2_PREFIX }).expect("AES-GCM encryption");
    [AES_V2_PREFIX, &nonce, &encrypted].concat()
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
    let cipher = Aes256Gcm::new_from_slice(&aes_v2_key(key)).expect("AES-256 key");
    let nonce: [u8; 12] = cipher_text[offset..offset + 12].try_into().unwrap();
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
    if let Some(other) = styles.iter().find(|st| !is_host(st)) {
        return Err(err(CODEC_UNSUPPORTED, format!("host style {other}")));
    }
    let mut cur: Vec<u8> = match v {
        Param::Null => return Ok(Param::Null),
        Param::Str(s) => s.as_bytes().to_vec(),
        Param::Bytes(b) => b.clone(),
        // A host stage takes text or bytes only (COD-1).
        _ => return Err(err(CODEC_ENCODE, "host input must be text or bytes")),
    };
    for st in styles {
        cur = match st.as_str() {
            "blind_index" => return Ok(Param::Str(blind_index(v, aes_key)?)),
            "aes" => {
                if aes_key.is_empty() {
                    return Err(Error::Config("secret aes not configured".into()));
                }
                aes_encrypt(&cur, aes_key)
            }
            "hex" => hex_upper(&cur).into_bytes(),
            "ip" => pack_ip(std::str::from_utf8(&cur).map_err(|e| err(CODEC_ENCODE, format!("ip: {e}")))?)?,
            other => return Err(err(CODEC_UNSUPPORTED, format!("host style {other}"))),
        };
    }
    Ok(match styles.last().map(String::as_str) {
        Some("hex") => Param::Str(String::from_utf8(cur).expect("hex text")),
        _ => Param::Bytes(cur),
    })
}

/// Undoes `host_encode` on a read cell (styles in write order, applied in reverse):
/// text when the bytes are UTF-8, bytes otherwise, the address text after `ip`.
pub fn host_decode(raw: &Val, styles: &[String], aes_key: &str) -> Result<Val> {
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
            "ip" => return Ok(Val::Str(unpack_ip(&cur)?)),
            other => return Err(err(CODEC_UNSUPPORTED, format!("host style {other}"))),
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
