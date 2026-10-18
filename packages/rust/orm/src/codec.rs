//! Column-style codecs (docs/codec.md): ordered_json, serialize, base64, gz, yaml.
//! Styles are listed in write order; `decode` applies them in reverse. A first `gz` or
//! `base64` stage takes a string value and stores its UTF-8 text (docs/codec.md, Stage lists).

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
    Error::Engine { code: code.into(), msg: msg.into() }
}

/// Stored cell → decoded value, or `Val::Null` for SQL NULL. The `ordered_json`
/// stage returns `Val::Ordered`; the other stages return `Val::Json`.
pub fn decode(styles: &[String], raw: &Val) -> Result<Val> {
    let mut cur: Vec<u8> = match raw {
        Val::Null => return Ok(Val::Null),
        // a driver-parsed JSON cell: only a bare json style applies
        Val::Json(v) if styles.len() == 1 && styles[0] == "ordered_json" => v.to_string().into_bytes(),
        Val::Str(s) => s.as_bytes().to_vec(),
        Val::Bytes(b) => b.clone(),
        other => return Err(err(CODEC_DECODE, format!("cell is {other:?}, not bytes"))),
    };
    let mut value: Option<Val> = None;
    for st in styles.iter().rev() {
        if value.is_some() {
            return Err(err(CODEC_DECODE, format!("style {st} after a decoded value")));
        }
        match st.as_str() {
            "gz" => {
                let mut out = Vec::new();
                flate2::read::ZlibDecoder::new(cur.as_slice()).read_to_end(&mut out).map_err(|e| err(CODEC_DECODE, format!("gz: {e}")))?;
                cur = out;
            }
            "base64" => {
                let text = std::str::from_utf8(&cur).map_err(|_| err(CODEC_DECODE, "base64 input is not UTF-8"))?;
                // A stored cell is decoded only in the form the encoder writes (docs/codec.md). STANDARD rejects whitespace, missing padding,
                // and nonzero padding bits.
                cur = base64::engine::general_purpose::STANDARD.decode(text).map_err(|e| err(CODEC_DECODE, format!("base64: {e}")))?;
            }
            "serialize" => value = Some(Val::Json(php_unserialize(&cur)?)),
            "yaml" => {
                value = Some(Val::Json(yaml_decode(&cur)?));
            }
            "ordered_json" => value = Some(Val::Ordered(strict_json::parse_bytes(&cur).map_err(|e| err(CODEC_DECODE, format!("json: {e}")))?)),
            other => return Err(err(CODEC_UNSUPPORTED, format!("style {other}"))),
        }
    }
    // Without a value stage (a list that starts with gz or base64) the value is the text of the bytes.
    Ok(match value {
        Some(value) => value,
        None => match String::from_utf8(cur) {
            Ok(text) => Val::Str(text),
            Err(_) if !styles.is_empty() => return Err(err(CODEC_DECODE, "decoded text is not valid UTF-8")),
            Err(error) => Val::Bytes(error.into_bytes()),
        },
    })
}

/// A first `gz` or `base64` stage takes bytes, so the value is a string and the stage encodes its UTF-8 text.
fn takes_text(stage: Option<&str>) -> bool {
    matches!(stage, Some("gz" | "base64"))
}

/// An ordered-json value → stored representation. The first stage is
/// `ordered_json` and writes the compact text of the value, including JSON null.
pub fn encode_ordered(styles: &[&str], v: StyledValue<&strict_json::Value>) -> Result<Param> {
    let StyledValue::Value(v) = v else { return Ok(Param::Null) };
    match styles.first() {
        Some(&"ordered_json") => finish(&styles[1..], v.compact().into_bytes()),
        _ => Err(err(CODEC_UNSUPPORTED, format!("an ordered-json value needs the first style ordered_json, not {styles:?}"))),
    }
}

/// Applies the stages that follow a value stage (base64, gz) to encoded bytes.
fn finish(styles: &[&str], mut cur: Vec<u8>) -> Result<Param> {
    for st in styles {
        match *st {
            "base64" => cur = base64::engine::general_purpose::STANDARD.encode(&cur).into_bytes(),
            "gz" => {
                let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
                enc.write_all(&cur).map_err(|e| err(CODEC_ENCODE, format!("gz: {e}")))?;
                return Ok(Param::Bytes(enc.finish().map_err(|e| err(CODEC_ENCODE, format!("gz: {e}")))?));
            }
            "ordered_json" | "serialize" | "yaml" => return Err(err(CODEC_UNSUPPORTED, format!("{st} must be the first style"))),
            other => return Err(err(CODEC_UNSUPPORTED, format!("style {other}"))),
        }
    }
    Ok(Param::Str(String::from_utf8(cur).map_err(|e| err(CODEC_ENCODE, e.to_string()))?))
}

/// Value → stored representation as a bind parameter (`Str`, or `Bytes` for gz).
pub fn encode(styles: &[&str], v: StyledValue<&Value>) -> Result<Param> {
    let StyledValue::Value(v) = v else { return Ok(Param::Null) };
    let mut cur: Vec<u8> = Vec::new();
    let value = v.clone();
    if takes_text(styles.first().copied()) {
        let Value::String(text) = &value else {
            return Err(err(CODEC_ENCODE, format!("a first {} stage takes a string value", styles[0])));
        };
        cur = text.clone().into_bytes();
    }
    for (i, st) in styles.iter().enumerate() {
        match *st {
            "serialize" => {
                if i != 0 {
                    return Err(err(CODEC_UNSUPPORTED, "serialize must be the first encoding style"));
                }
                let mut s = String::new();
                php_serialize(&mut s, &value)?;
                cur = s.into_bytes();
            }
            "yaml" => {
                if i != 0 {
                    return Err(err(CODEC_UNSUPPORTED, "yaml must be the first style"));
                }
                cur = yaml_encode(&value)?;
            }
            "ordered_json" => {
                if i != 0 {
                    return Err(err(CODEC_UNSUPPORTED, "ordered_json must be the first style"));
                }
                let raw = serde_json::to_vec(&value).map_err(|e| err(CODEC_ENCODE, format!("json: {e}")))?;
                let parsed = strict_json::parse_bytes(&raw).map_err(|e| err(CODEC_ENCODE, format!("json: {e}")))?;
                cur = strict_json::stringify(&parsed).into_bytes();
            }
            "base64" => cur = base64::engine::general_purpose::STANDARD.encode(&cur).into_bytes(),
            "gz" => {
                let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
                enc.write_all(&cur).map_err(|e| err(CODEC_ENCODE, format!("gz: {e}")))?;
                return Ok(Param::Bytes(enc.finish().map_err(|e| err(CODEC_ENCODE, format!("gz: {e}")))?));
            }
            other => return Err(err(CODEC_UNSUPPORTED, format!("style {other}"))),
        }
    }
    Ok(Param::Str(String::from_utf8(cur).map_err(|e| err(CODEC_ENCODE, e.to_string()))?))
}

// ---- yaml: YAML 1.2 with the core schema: read through saphyr-parser, written by serde-saphyr ----

/// A collection the reader is building: a sequence, or a mapping with the key of the
/// value that comes next.
enum YamlFrame {
    Sequence(Vec<Value>),
    Mapping { map: Map<String, Value>, key: Option<String> },
}

/// Builds the common value of one YAML document from the parser events, and refuses
/// in the same pass every form that docs/codec.md (yaml) refuses.
#[derive(Default)]
struct YamlReader {
    documents: usize,
    frames: Vec<YamlFrame>,
    value: Option<Value>,
    error: Option<String>,
}

impl YamlReader {
    fn fail(&mut self, mark: YamlMarker, message: impl AsRef<str>) {
        if self.error.is_none() {
            self.error = Some(format!("{} at line {}, column {}", message.as_ref(), mark.line(), mark.col()));
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
                        return self.fail(mark, format!("duplicate map key {name:?}"));
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
                        Err(message) => self.fail(mark, message),
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

static YAML_CORE_INT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\A(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)\z").unwrap());
static YAML_CORE_FLOAT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\A(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))\z").unwrap());

/// Resolves a plain scalar by the tags of the YAML 1.2 core schema (YAML 1.2.2, 10.3.2):
/// null, bool, int and float by their regular expressions, and str otherwise. saphyr-parser
/// reports a plain scalar as its text and resolves no tag, so the core schema is applied here. An integer
/// outside i64 and a float that is not finite are outside the common value model.
fn yaml_core_scalar(text: String) -> std::result::Result<Value, String> {
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
            Value::from(parsed.map_err(|_| format!("integer {text} is outside the i64 range"))?)
        }
        _ if YAML_CORE_FLOAT.is_match(&text) => match text.parse::<f64>().ok().filter(|float| float.is_finite()).and_then(serde_json::Number::from_f64) {
            Some(number) => Value::Number(number),
            None => return Err(format!("non-finite number {text} is not supported")),
        },
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
    let source = std::str::from_utf8(bytes).map_err(|e| err(CODEC_DECODE, format!("yaml: invalid UTF-8: {e}")))?;
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    if let Some((at, c)) = source.char_indices().find(|&(_, c)| !yaml_printable(c)) {
        return Err(err(CODEC_DECODE, format!("yaml: character U+{:04X} at byte {at} is not printable", c as u32)));
    }
    let mut reader = YamlReader::default();
    YamlParser::new_from_str(source).load(&mut reader, true).map_err(|e| err(CODEC_DECODE, format!("yaml: {e}")))?;
    match reader.error {
        Some(message) => Err(err(CODEC_DECODE, format!("yaml: {message}"))),
        None if reader.documents == 0 => Err(err(CODEC_DECODE, "yaml: no document")),
        None => Ok(reader.value.unwrap_or(Value::Null)),
    }
}

/// Writes a common value as one YAML document with serde-saphyr, which quotes every string the
/// core schema would read as another value and escapes every character outside c-printable. A
/// number outside the common value model returns CODEC_ENCODE. The written text is read back, and
/// a text that does not read back as the value returns CODEC_ENCODE instead of storing it.
fn yaml_encode(value: &Value) -> Result<Vec<u8>> {
    yaml_number_check(value)?;
    let text = serde_saphyr::to_string(value).map_err(|e| err(CODEC_ENCODE, format!("yaml: {e}")))?;
    match yaml_decode(text.as_bytes()) {
        Ok(read) if read == *value => Ok(text.into_bytes()),
        Ok(read) => Err(err(CODEC_ENCODE, format!("yaml: the written text {text:?} reads back as {read}, not {value}"))),
        Err(e) => Err(err(CODEC_ENCODE, format!("yaml: the written text {text:?} does not read back: {e}"))),
    }
}

/// Refuses a number the common value model does not hold: an integer beyond i64.
fn yaml_number_check(value: &Value) -> Result<()> {
    match value {
        Value::Number(number) if number.is_u64() && number.as_i64().is_none() => {
            Err(err(CODEC_ENCODE, format!("yaml: integer {number} is outside the i64 range")))
        }
        Value::Array(items) => items.iter().try_for_each(yaml_number_check),
        Value::Object(map) => map.values().try_for_each(yaml_number_check),
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
                return Err(err(CODEC_ENCODE, format!("number {n} out of range")));
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
    k.parse::<i64>().ok()
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
    if (-4..21).contains(&exp) {
        return format!("{f}"); // Display: "2", "0.1", "1.5"
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
        let s = std::str::from_utf8(&rest[..j]).map_err(|_| self.fail("bad utf-8"))?;
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
                    b'i' => s.parse::<i64>().map(Value::from).map_err(|_| self.fail("bad int")),
                    _ => {
                        let f = match s {
                            "INF" => f64::INFINITY,
                            "-INF" => f64::NEG_INFINITY,
                            "NAN" => f64::NAN,
                            _ => s.parse::<f64>().map_err(|_| self.fail("bad float"))?,
                        };
                        serde_json::Number::from_f64(f).map(Value::Number).ok_or_else(|| self.fail("non-finite float"))
                    }
                }
            }
            b's' => {
                self.expect(b':')?;
                let n: usize = self.until(b':')?.parse().map_err(|_| self.fail("bad string length"))?;
                self.expect(b'"')?;
                if self.i + n > self.b.len() {
                    return Err(self.fail("string overruns input"));
                }
                let s = String::from_utf8(self.b[self.i..self.i + n].to_vec()).map_err(|_| self.fail("string is not utf-8"))?;
                self.i += n;
                self.expect(b'"')?;
                self.expect(b';')?;
                Ok(Value::String(s))
            }
            b'a' => {
                self.expect(b':')?;
                let n: usize = self.until(b':')?.parse().map_err(|_| self.fail("bad array length"))?;
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
            b'O' | b'C' | b'r' | b'R' => Err(err(CODEC_UNSUPPORTED, format!("serialize: objects and references are not supported ({})", t as char))),
            other => Err(self.fail(&format!("unknown type {}", other as char))),
        }
    }
}

/// A positional column with executor-side stages: the codec stages (docs/codec.md) and the
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

// ---- host stages (docs/dialects.md): what MySQL does in SQL, PostgreSQL/SQLite leave to the executor ----

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
        other => format!("{other:?}").into_bytes(),
    };
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key.as_bytes()).map_err(|_| Error::Config("invalid blind_index key".into()))?;
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
    cipher.decrypt(&nonce, Payload { msg: &cipher_text[offset + 12..], aad: AES_V2_PREFIX }).map_err(|_| err(CODEC_DECODE, "aes: authentication failed"))
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

/// Reads the upper-case hex text that `hex_upper` writes. The
/// text is decoded exactly: a lower-case letter, white space or any other byte
/// outside the upper-case hex digits is `CODEC_DECODE` (docs/codec.md).
pub fn hex_decode(s: &str) -> Result<Vec<u8>> {
    let s = s.as_bytes();
    if !s.len().is_multiple_of(2) {
        return Err(err(CODEC_DECODE, "hex: odd length"));
    }
    let nibble = |c: u8| -> Result<u8> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err(err(CODEC_DECODE, format!("hex: invalid byte {c:#x}"))),
        }
    };
    s.as_chunks::<2>().0.iter().map(|p| Ok(nibble(p[0])? << 4 | nibble(p[1])?)).collect()
}

/// `INET6_ATON`: 4 bytes for IPv4, 16 for IPv6.
fn pack_ip(s: &str) -> Result<Vec<u8>> {
    // The exact text only: white space around the address is CODEC_ENCODE (docs/codec.md).
    match s.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(a)) => Ok(a.octets().to_vec()),
        Ok(std::net::IpAddr::V6(a)) => Ok(a.octets().to_vec()),
        Err(_) => Err(err(CODEC_ENCODE, format!("ip: {s:?} is not an address"))),
    }
}

/// `INET6_NTOA`.
fn unpack_ip(b: &[u8]) -> Result<String> {
    match b.len() {
        4 => Ok(std::net::Ipv4Addr::from(<[u8; 4]>::try_from(b).unwrap()).to_string()),
        16 => Ok(std::net::Ipv6Addr::from(<[u8; 16]>::try_from(b).unwrap()).to_string()),
        n => Err(err(CODEC_DECODE, format!("ip: {n} packed bytes"))),
    }
}

/// Applies the host stages of a bound value in write order (`bind_slots[].host_styles`).
/// The result binds as text after `hex`, as bytes otherwise; NULL stays NULL.
pub fn host_encode(v: &Param, styles: &[String], aes_key: &str) -> Result<Param> {
    let mut cur: Vec<u8> = match v {
        Param::Null => return Ok(Param::Null),
        Param::Str(s) => s.as_bytes().to_vec(),
        Param::Bytes(b) => b.clone(),
        Param::Bool(b) => b.to_string().into_bytes(),
        Param::I64(x) => x.to_string().into_bytes(),
        Param::F64(x) => x.to_string().into_bytes(),
        Param::DateTime(t) => t.format("%Y-%m-%d %H:%M:%S%.6f").to_string().into_bytes(),
        Param::Date(d) => d.to_string().into_bytes(),
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
        other => return Err(err(CODEC_DECODE, format!("cell is {other:?}, not bytes"))),
    };
    for st in styles.iter().rev() {
        cur = match st.as_str() {
            "hex" => hex_decode(std::str::from_utf8(&cur).map_err(|_| err(CODEC_DECODE, "hex input is not UTF-8"))?)?,
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
mod tests {
    use super::*;

    /// AES v2 uses an authenticated envelope and rejects tampering.
    #[test]
    fn aes_vectors() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let styles = vec!["aes".to_string(), "hex".to_string()];
        let encoded = host_encode(&Param::Str("member@example.test".into()), &styles, "key-v1").unwrap();
        let Param::Str(encoded) = encoded else { panic!("AES+hex must produce text") };
        assert_eq!(host_decode(&Val::Str(encoded.clone()), &styles, "key-v1").unwrap(), Val::Str("member@example.test".into()));
        let mut tampered = hex_decode(&encoded).unwrap();
        *tampered.last_mut().unwrap() ^= 1;
        assert_eq!(host_decode(&Val::Str(hex_upper(&tampered)), &styles, "key-v1").unwrap_err().code(), CODEC_DECODE);
        assert_eq!(host_encode(&Param::Null, &styles, "key-v1").unwrap(), Param::Null);
        let fixed = hex_decode("4F524D2D414553320000112233445566778899AABB651DA9F08BE2FA7CD7B2DF5C04D91B32189DCD854A70762F99271A2BEBA64A248E24").unwrap();
        assert_eq!(host_decode(&Val::Str(hex_upper(&fixed)), &styles, "bench-salt").unwrap(), Val::Str("user42@example.com".into()));
    }

    #[test]
    fn blind_index_vector() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        assert_eq!(
            blind_index(&Param::Str("member@example.test".into()), "blind-key").unwrap(),
            "1992d5622b305dec915751bc7382d3c0ed9e130f2cc62ab3560e244953160fa8"
        );
    }

    #[test]
    fn errors_and_keys() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        for (styles, raw, code) in [
            (vec!["ordered_json"], "{bad", "CODEC_DECODE"),
            (vec!["serialize"], "O:8:\"stdClass\":0:{}", "CODEC_UNSUPPORTED"),
            (vec!["serialize"], "a:1:{i:0;", "CODEC_DECODE"),
            (vec!["serialize", "gz"], "not zlib", "CODEC_DECODE"),
            (vec!["serialize", "base64"], "@@@", "CODEC_DECODE"),
            (vec!["yaml"], "a: 1\na: 2\n", "CODEC_DECODE"),
            (vec!["yaml"], "---\na: 1\n---\na: 2\n", "CODEC_DECODE"),
            (vec!["yaml"], "a: &x [1]\nb: *x\n", "CODEC_DECODE"),
            (vec!["yaml"], "a: !custom value\n", "CODEC_DECODE"),
            (vec!["yaml"], "value: .inf\n", "CODEC_DECODE"),
            (vec!["yaml"], "true: value\n", "CODEC_DECODE"),
        ] {
            let styles: Vec<String> = styles.into_iter().map(String::from).collect();
            match decode(&styles, &Val::Str(raw.into())) {
                Err(e) => assert_eq!(e.code(), code, "{raw}"),
                Ok(v) => panic!("{raw}: {v:?}"),
            }
        }
        let v: Value = serde_json::json!({"07": 1, "-3": 2, "10": 3, "x": 4.0, "y": 1e25});
        match encode(&["serialize"], StyledValue::Value(&v)).unwrap() {
            Param::Str(s) => assert_eq!(s, "a:5:{i:-3;i:2;s:2:\"07\";i:1;i:10;i:3;s:1:\"x\";d:4;s:1:\"y\";d:1.0E+25;}"),
            other => panic!("{other:?}"),
        }
        assert_eq!(encode(&["filepart"], StyledValue::Value(&serde_json::json!({}))).unwrap_err().code(), CODEC_UNSUPPORTED);
        assert_eq!(encode(&["serialize", "yaml"], StyledValue::Value(&serde_json::json!({}))).unwrap_err().code(), CODEC_UNSUPPORTED);
        let yaml = vec!["yaml".to_string()];
        assert_eq!(decode(&yaml, &Val::Str("1: value\n".into())).unwrap(), Val::Json(serde_json::json!({"1": "value"})));
        assert_eq!(decode(&["base64".into()], &Val::Bytes(vec![0xff])).unwrap_err().code(), CODEC_DECODE);
        assert_eq!(host_decode(&Val::Bytes(vec![0xff]), &["hex".into()], "").unwrap_err().code(), CODEC_DECODE);
        assert_eq!(decode(&["serialize".into()], &Val::Str("b:2;".into())).unwrap_err().code(), CODEC_DECODE);
        assert_eq!(decode(&["serialize".into()], &Val::Str("d:NAN;".into())).unwrap_err().code(), CODEC_DECODE);
        assert_eq!(decode(&[], &Val::Bytes(vec![0xff])).unwrap(), Val::Bytes(vec![0xff]));
        assert_eq!(decode(&[], &Val::Str(String::new())).unwrap(), Val::Str(String::new()));
        assert_eq!(decode(&["ordered_json".into()], &Val::Str(String::new())).unwrap_err().code(), CODEC_DECODE);
    }

    /// The yaml stage reads one YAML 1.2 document with the core schema into the common value
    /// model (docs/codec.md, yaml): plain scalars resolve by the core schema tags, integral keys
    /// become decimal strings, and the refused forms return CODEC_DECODE instead of a string.
    #[test]
    fn yaml_reads_the_core_schema() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let yaml = vec!["yaml".to_string()];
        let mut wrong = Vec::new();
        for (text, want) in [
            ("---\n", serde_json::json!(null)),
            ("\u{feff}a: 1\n", serde_json::json!({"a": 1})),
            ("Null\n", serde_json::json!(null)),
            ("NULL\n", serde_json::json!(null)),
            ("~\n", serde_json::json!(null)),
            ("a:\n", serde_json::json!({"a": null})),
            ("07\n", serde_json::json!(7)),
            ("0o17\n", serde_json::json!(15)),
            ("0x1F\n", serde_json::json!(31)),
            ("+12\n", serde_json::json!(12)),
            ("-9223372036854775808\n", serde_json::json!(i64::MIN)),
            ("0b101\n", serde_json::json!("0b101")),
            ("-0x1\n", serde_json::json!("-0x1")),
            ("0x-1\n", serde_json::json!("0x-1")),
            ("1_000\n", serde_json::json!("1_000")),
            ("tRuE\n", serde_json::json!("tRuE")),
            ("yes\n", serde_json::json!("yes")),
            (".nAn\n", serde_json::json!(".nAn")),
            ("'true'\n", serde_json::json!("true")),
            ("\"07\"\n", serde_json::json!("07")),
            ("1e3\n", serde_json::json!(1000.0)),
            (".5\n", serde_json::json!(0.5)),
            ("2.0\n", serde_json::json!(2.0)),
            ("-0.0\n", serde_json::json!(-0.0)),
            ("0x1F: a\n07: b\n+3: c\n", serde_json::json!({"31": "a", "7": "b", "3": "c"})),
            ("'1.5': a\n'true': b\n", serde_json::json!({"1.5": "a", "true": "b"})),
            ("tRuE: a\n", serde_json::json!({"tRuE": "a"})),
        ] {
            match decode(&yaml, &Val::Str(text.into())) {
                Ok(Val::Json(got)) if got == want && format!("{got:?}") == format!("{want:?}") => {}
                other => wrong.push(format!("{text:?}: got {other:?}, want {want}")),
            }
        }
        for text in [
            "9223372036854775808\n",
            "0x8000000000000000\n",
            "1e400\n",
            "-.INF\n",
            ".NaN\n",
            "a: [.inf]\n",
            "? [a]\n: b\n",
            "? {a: 1}\n: b\n",
            "~: a\n",
            "Null: a\n",
            "1.5: a\n",
            "False: a\n",
            "1e3: a\n",
            "",
            "# comment\n",
            "a: !!str x\n",
            "a: ! x\n",
            "!!map {a: 1}\n",
            "&x a\n",
            "a: &x [1]\n",
            "1: a\n01: b\n",
            "a: 1\n'a': 2\n",
            "--- 1\n--- 2\n",
            "a: [1\n",
            "a: x\u{7}y\n",
            "a: \"x\u{9f}\"\n",
            "a: \u{feff}x\n",
        ] {
            match decode(&yaml, &Val::Str(text.into())) {
                Err(e) if e.code() == CODEC_DECODE => {}
                other => wrong.push(format!("{text:?}: got {other:?}, want CODEC_DECODE")),
            }
        }
        assert_eq!(decode(&yaml, &Val::Bytes(vec![b'a', b':', b' ', 0xff])).unwrap_err().code(), CODEC_DECODE);
        assert!(wrong.is_empty(), "Rust yaml decode:\n{}", wrong.join("\n"));
    }

    /// A YAML write reads back as the same value, floats as floats; a value the common value
    /// model does not hold, or text that does not read back as the value, returns CODEC_ENCODE.
    #[test]
    fn yaml_writes_what_it_reads() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let yaml = vec!["yaml".to_string()];
        let mut wrong = Vec::new();
        for value in [
            serde_json::json!(null),
            serde_json::json!(2.0),
            serde_json::json!(-0.0),
            serde_json::json!(1e25),
            serde_json::json!(1e-7),
            serde_json::json!(i64::MIN),
            serde_json::json!(i64::MAX),
            serde_json::json!([
                "",
                " a",
                "a ",
                "07",
                "1e3",
                "Null",
                "yes",
                "~",
                "-",
                "0x1F",
                "a\nb",
                "a: b",
                "#",
                "\u{85}",
                "한글",
                "0o17",
                "\u{7}",
                "a\u{1b}",
                "a\u{7f}",
                "\u{9f}",
                "\u{feff}a",
                "\u{fffe}",
                "\u{ffff}",
                "0x1F",
                "1_000",
                "2014-12-31"
            ]),
            serde_json::json!({"1": [], "07": {}, "true": [[1, 2], {"a": [null]}], "": "x"}),
        ] {
            let text = match encode(&["yaml"], StyledValue::Value(&value)) {
                Ok(Param::Str(text)) => text,
                other => {
                    wrong.push(format!("{value}: encode {other:?}"));
                    continue;
                }
            };
            match decode(&yaml, &Val::Str(text.clone())) {
                Ok(Val::Json(got)) if got == value && format!("{got:?}") == format!("{value:?}") => {}
                other => wrong.push(format!("{value}: wrote {text:?}, read {other:?}")),
            }
        }
        assert!(wrong.is_empty(), "Rust yaml encode:\n{}", wrong.join("\n"));
        assert_eq!(encode(&["yaml"], StyledValue::Value(&serde_json::json!(u64::MAX))).unwrap_err().code(), CODEC_ENCODE);
    }

    /// The json stage returns the ordered-json value with its member order,
    /// number text, and {} apart from []; the write keeps the same text.
    #[test]
    fn json_stage_keeps_ordered_json() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let text = r#"{"b":1,"a":[],"c":{},"n":1.50}"#;
        for styles in [vec!["ordered_json"], vec!["ordered_json", "gz"], vec!["ordered_json", "base64"]] {
            let value = strict_json::parse(text).unwrap();
            let stored = encode_ordered(&styles, StyledValue::Value(&value)).unwrap();
            let raw = match stored {
                Param::Str(s) => Val::Str(s),
                Param::Bytes(b) => Val::Bytes(b),
                other => panic!("{styles:?}: stored {other:?}"),
            };
            if styles.len() == 1 {
                assert_eq!(raw, Val::Str(text.into()), "{styles:?}: stored text");
            }
            let owned: Vec<String> = styles.iter().map(|s| s.to_string()).collect();
            match decode(&owned, &raw).unwrap() {
                Val::Ordered(v) => assert_eq!(v.compact(), text, "{styles:?}: read"),
                other => panic!("{styles:?}: read {other:?}"),
            }
        }
        assert_eq!(encode_ordered(&["ordered_json"], StyledValue::Value(&strict_json::Value::null())).unwrap(), Param::Str("null".into()));
        assert_eq!(encode_ordered(&["serialize"], StyledValue::Value(&strict_json::parse("{}").unwrap())).unwrap_err().code(), CODEC_UNSUPPORTED);
        assert_eq!(decode(&["ordered_json".to_string()], &Val::Str("{".into())).unwrap_err().code(), CODEC_DECODE);
    }

    /// A first `gz` or `base64` stage serializes nothing: it stores the UTF-8 text of a string value and refuses any
    /// other value (docs/codec.md, Stage lists).
    #[test]
    fn leading_gz_and_base64_store_the_text() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let value = serde_json::json!({"a": [1, "x"], "b": null});
        let text = Value::String("한 text".into());
        for stage in ["gz", "base64"] {
            assert_eq!(encode(&[stage], StyledValue::Value(&value)).unwrap_err().code(), CODEC_ENCODE, "{stage}: a map");
            let raw = match encode(&[stage], StyledValue::Value(&text)).unwrap() {
                Param::Str(s) => Val::Str(s),
                Param::Bytes(b) => Val::Bytes(b),
                other => panic!("{stage}: stored {other:?}"),
            };
            assert_eq!(decode(&[stage.to_string()], &raw).unwrap(), Val::Str("한 text".into()), "{stage}: read");
            assert_eq!(encode(&[stage], StyledValue::SqlNull).unwrap(), Param::Null, "{stage}: SQL NULL write");
        }
    }

    #[test]
    fn json_literal_null_is_distinct_from_sql_null() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let literal = strict_json::Value::null();
        let stored = encode_ordered(&["ordered_json"], StyledValue::Value(&literal)).unwrap();
        assert_eq!(stored, Param::Str("null".into()));
        assert_eq!(decode(&["ordered_json".into()], &Val::Str("null".into())).unwrap(), Val::Ordered(literal));
        assert_eq!(decode(&["ordered_json".into()], &Val::Null).unwrap(), Val::Null);
        assert_eq!(encode(&["ordered_json"], StyledValue::Value(&Value::Null)).unwrap(), Param::Str("null".into()));
        assert_eq!(encode(&["ordered_json"], StyledValue::SqlNull).unwrap(), Param::Null);
        for style in ["serialize", "yaml"] {
            let stored = encode(&[style], StyledValue::Value(&Value::Null)).unwrap();
            let Param::Str(text) = stored else { panic!("{style}: expected stored text") };
            assert!(!text.is_empty(), "{style}: a value cannot become SQL NULL or empty text");
            assert_eq!(decode(&[style.into()], &Val::Str(text)).unwrap(), Val::Json(Value::Null), "{style}: literal null round trip");
            assert_eq!(encode(&[style], StyledValue::SqlNull).unwrap(), Param::Null, "{style}: SQL NULL write");
            assert_eq!(decode(&[style.into()], &Val::Null).unwrap(), Val::Null, "{style}: SQL NULL read");
        }
    }
}
