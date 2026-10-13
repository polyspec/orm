//! Column-style codecs (docs/codec.md): ordered_json, serialize, base64, gz, yaml.
//! Styles are listed in write order; `decode` applies them in reverse. 첫 stage가
//! `gz`나 `base64`이면 값을 먼저 PHP serialize한다.

use std::io::{Read, Write};
use std::sync::LazyLock;

use base64::Engine as _;
use ordered_json as strict_json;
use regex::Regex;
use serde_json::{Map, Value};
use yaml_rust2::parser::{Event as YamlEvent, MarkedEventReceiver, Parser as YamlParser};
use yaml_rust2::scanner::{Marker as YamlMarker, TScalarStyle};
use yaml_rust2::yaml::{Hash as YamlHash, Yaml};
use yaml_rust2::YamlEmitter;

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
                // 저장 cell은 encoder가 쓰는 형태로만 decode한다(docs/codec.md). STANDARD는 공백, 빠진 padding,
                // 0이 아닌 padding bit를 거절한다.
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
    if value.is_none() && serializes_first(styles.first().map(String::as_str)) {
        value = Some(Val::Json(php_unserialize(&cur)?));
    }
    Ok(match value {
        Some(value) => value,
        None => match String::from_utf8(cur) {
            Ok(text) => Val::Str(text),
            Err(error) => Val::Bytes(error.into_bytes()),
        },
    })
}

/// 첫 stage가 `gz`나 `base64`이면 그 stage 앞에서 값을 PHP serialize한다 (docs/codec.md).
fn serializes_first(stage: Option<&str>) -> bool {
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
    if serializes_first(styles.first().copied()) {
        let mut s = String::new();
        php_serialize(&mut s, &value)?;
        cur = s.into_bytes();
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

// ---- yaml: YAML 1.2 with the core schema, through yaml-rust2 ----

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

impl MarkedEventReceiver for YamlReader {
    fn on_event(&mut self, event: YamlEvent, mark: YamlMarker) {
        if self.error.is_some() {
            return;
        }
        match event {
            YamlEvent::DocumentStart => {
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
                } else if style != TScalarStyle::Plain {
                    self.place(Value::String(text), mark);
                } else {
                    match yaml_core_scalar(text) {
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
/// null, bool, int and float by their regular expressions, and str otherwise. yaml-rust2
/// reports a plain scalar as its text; its `Yaml::from_str` is not the core schema (it reads
/// `Null` as a string, `0x-1` as an integer, and an integer beyond i64 as a float). An integer
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

/// Reads one YAML document into the common value model in one pass of the yaml-rust2 parser.
/// A stream without a document, or an empty document, is null. yaml-rust2 neither refuses a
/// character outside c-printable nor removes the byte order mark, so the reader does both.
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
        None => Ok(reader.value.unwrap_or(Value::Null)),
    }
}

/// The yaml-rust2 node of a common value. A float is written in the shortest form that reads
/// back as the same f64 and always holds a `.` or an exponent, so it reads back as a float.
fn yaml_node(value: &Value) -> Result<Yaml> {
    Ok(match value {
        Value::Null => Yaml::Null,
        Value::Bool(boolean) => Yaml::Boolean(*boolean),
        Value::Number(number) => match (number.as_i64(), number.as_f64()) {
            (Some(integer), _) => Yaml::Integer(integer),
            (None, _) if number.is_u64() => return Err(err(CODEC_ENCODE, format!("yaml: integer {number} is outside the i64 range"))),
            (None, Some(float)) if float.is_finite() => Yaml::Real(format!("{float:?}")),
            _ => return Err(err(CODEC_ENCODE, format!("yaml: number {number} is outside the common value model"))),
        },
        Value::String(text) => Yaml::String(text.clone()),
        Value::Array(items) => Yaml::Array(items.iter().map(yaml_node).collect::<Result<_>>()?),
        Value::Object(map) => {
            let mut hash = YamlHash::new();
            for (key, item) in map {
                hash.insert(Yaml::String(key.clone()), yaml_node(item)?);
            }
            Yaml::Hash(hash)
        }
    })
}

/// Writes a common value as one YAML document with the yaml-rust2 emitter. The written text
/// is read back, and a text that does not read back as the value (the emitter leaves some
/// strings plain that the core schema reads as another value, such as `0o17`) returns
/// CODEC_ENCODE instead of storing a different value.
fn yaml_encode(value: &Value) -> Result<Vec<u8>> {
    let node = yaml_node(value)?;
    let mut text = String::new();
    YamlEmitter::new(&mut text).dump(&node).map_err(|e| err(CODEC_ENCODE, format!("yaml: {e}")))?;
    text.push('\n');
    match yaml_decode(text.as_bytes()) {
        Ok(read) if read == *value => Ok(text.into_bytes()),
        Ok(read) => Err(err(CODEC_ENCODE, format!("yaml: the written text {text:?} reads back as {read}, not {value}"))),
        Err(e) => Err(err(CODEC_ENCODE, format!("yaml: the written text {text:?} does not read back: {e}"))),
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

/// executor codec이 적용하는 stage를 쓰기 순서로 돌려준다. `aes`, `hex`, `ip`는 host stage다.
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

/// `HEX(...)`: upper-case hex text.
pub fn hex_upper(b: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    let mut s = String::with_capacity(b.len() * 2);
    for &x in b {
        s.push(DIGITS[(x >> 4) as usize] as char);
        s.push(DIGITS[(x & 15) as usize] as char);
    }
    s
}

/// Reads the upper-case hex text that `hex_upper` and MySQL `HEX()` write. The
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
    match s.trim().parse::<std::net::IpAddr>() {
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

    #[derive(serde::Deserialize)]
    struct Vector {
        name: String,
        styles: Vec<String>,
        value: Value,
        encoded_b64: Option<String>,
        deterministic: bool,
    }

    /// JSON cannot distinguish 2.0 from 2: compare with integral floats folded to integers.
    fn norm(v: &Value) -> Value {
        match v {
            Value::Number(n) => match n.as_f64() {
                Some(f) if n.as_i64().is_none() && f.fract() == 0.0 && f.abs() < 9.0e15 => Value::from(f as i64),
                _ => v.clone(),
            },
            Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
            Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), norm(x))).collect()),
            _ => v.clone(),
        }
    }

    /// 공유 decode vector(tests/codec/decode-vectors.json): 저장 cell은 encoder가 쓰는 형태로만 decode되고
    /// 그 밖의 형태는 CODEC_DECODE다. aes가 없는 host stage 목록은 key 없는 `host_decode`로, 나머지는
    /// `decode`로 읽는다.
    #[test]
    fn decode_vectors() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let root = polyspec_orm_testcase::manifest_dir().join("../../../tests/codec");
        let src = std::fs::read(root.join("decode-vectors.json")).expect("decode-vectors.json");
        let f: Value = serde_json::from_slice(&src).unwrap();
        let vectors = f["vectors"].as_array().expect("vectors");
        assert!(!vectors.is_empty(), "decode-vectors.json has no vectors");
        let mut wrong = Vec::new();
        for v in vectors {
            let name = v["name"].as_str().unwrap();
            let styles: Vec<String> = v["styles"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_owned()).collect();
            let raw = match (v["stored"].as_str(), v["stored_hex"].as_str()) {
                (Some(text), _) => Val::Str(text.to_owned()),
                (None, Some(hex)) => Val::Bytes(hex_decode(&hex.to_ascii_uppercase()).unwrap()),
                _ => panic!("{name}: no stored cell"),
            };
            let host = styles.iter().all(|s| s == "hex" || s == "ip");
            let got = if host { host_decode(&raw, &styles, "") } else { decode(&styles, &raw) };
            let text = |val: &Val| match val {
                Val::Str(s) => Some(s.clone()),
                Val::Json(Value::String(s)) => Some(s.clone()),
                _ => None,
            };
            match (&got, v["error"].as_str(), v["value"].as_str()) {
                (Err(e), Some(code), _) if e.code() == code => {}
                (Ok(val), None, Some(want)) if text(val).as_deref() == Some(want) => {}
                _ => wrong.push(format!("{name}: got {got:?}, want {}", v.get("error").or(v.get("value")).unwrap())),
            }
        }
        assert!(wrong.is_empty(), "Rust decode vectors:\n{}", wrong.join("\n"));
    }

    /// Every PHP-produced vector decodes to the same value; deterministic styles re-encode
    /// to the same bytes. When ORM_CODEC_OUT names a directory (make codec-check), Rust's encodings go
    /// to rust.json there for the PHP cross-check, through a temporary file and a rename.
    #[test]
    fn vectors() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let root = polyspec_orm_testcase::manifest_dir().join("../../../tests/codec");
        let src = std::fs::read(root.join("vectors.json")).expect("vectors.json");
        let f: serde_json::Map<String, Value> = serde_json::from_slice(&src).unwrap();
        let mut vectors: Vec<Vector> = serde_json::from_value(f["vectors"].clone()).unwrap();
        let mut out = Map::new();
        let mut fails = 0;
        for v in &mut vectors {
            // codec vector의 `json` stage는 dbspec의 `ordered_json` stage다.
            for style in &mut v.styles {
                if style == "json" || style == "jsons" {
                    *style = "ordered_json".into();
                }
            }
        }
        for v in &vectors {
            let raw = match &v.encoded_b64 {
                None => Val::Null,
                Some(b) => Val::Bytes(base64::engine::general_purpose::STANDARD.decode(b).unwrap()),
            };
            let decoded = decode(&v.styles, &raw);
            if matches!(raw, Val::Null) != matches!(decoded, Ok(Val::Null)) {
                fails += 1;
                eprintln!("{}: SQL NULL state changed during decode", v.name);
            }
            let got = match &decoded {
                Ok(Val::Json(j)) => j.clone(),
                Ok(Val::Ordered(o)) => crate::value::ordered_to_json(o).unwrap(),
                Ok(Val::Null) => Value::Null,
                other => {
                    fails += 1;
                    eprintln!("{}: decode {:?}", v.name, other);
                    continue;
                }
            };
            if norm(&got) != norm(&v.value) {
                fails += 1;
                eprintln!("{}: decoded {got} want {}", v.name, v.value);
            }
            let styles: Vec<&str> = v.styles.iter().map(String::as_str).collect();
            let enc = match &decoded {
                Ok(Val::Null) => encode(&styles, StyledValue::SqlNull).unwrap(),
                Ok(Val::Ordered(o)) => encode_ordered(&styles, StyledValue::Value(o)).unwrap(),
                _ => encode(&styles, StyledValue::Value(&got)).unwrap(),
            };
            let enc_b64 = match &enc {
                Param::Null => None,
                Param::Str(s) => Some(base64::engine::general_purpose::STANDARD.encode(s.as_bytes())),
                Param::Bytes(b) => Some(base64::engine::general_purpose::STANDARD.encode(b)),
                _ => unreachable!(),
            };
            out.insert(v.name.clone(), enc_b64.clone().map(Value::String).unwrap_or(Value::Null));
            if v.deterministic && enc_b64 != v.encoded_b64 {
                fails += 1;
                eprintln!("{}: encoded {:?} want {:?}", v.name, enc_b64, v.encoded_b64);
            }
            let back_raw = match enc {
                Param::Null => Val::Null,
                Param::Str(s) => Val::Str(s),
                Param::Bytes(b) => Val::Bytes(b),
                _ => unreachable!(),
            };
            match decode(&v.styles, &back_raw) {
                Ok(Val::Json(j)) if norm(&j) == norm(&v.value) => {}
                Ok(Val::Ordered(o)) if crate::value::ordered_to_json(&o).is_ok_and(|j| norm(&j) == norm(&v.value)) => {}
                Ok(Val::Null) if v.value.is_null() => {}
                other => {
                    fails += 1;
                    eprintln!("{}: round trip {:?}", v.name, other);
                }
            }
        }
        if let Some(dir) = std::env::var_os("ORM_CODEC_OUT") {
            let dir = std::path::PathBuf::from(dir);
            std::fs::create_dir_all(&dir).expect("ORM_CODEC_OUT directory");
            let temporary = dir.join(format!("rust.json.tmp-{}", std::process::id()));
            std::fs::write(&temporary, serde_json::to_string_pretty(&Value::Object(out)).unwrap()).expect("rust.json");
            std::fs::rename(&temporary, dir.join("rust.json")).expect("rust.json rename");
        }
        assert_eq!(fails, 0);
    }

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
            ("", serde_json::json!(null)),
            ("# comment\n", serde_json::json!(null)),
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
            serde_json::json!(["", " a", "a ", "07", "1e3", "Null", "yes", "~", "-", "0x1F", "a\nb", "a: b", "#", "\u{85}", "한글"]),
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
        // The yaml-rust2 emitter writes these strings plain or unescaped: `0o17` reads back as 15,
        // and the control characters, C1 characters and the byte order mark are not printable.
        for text in ["0o17", "\u{7}", "a\u{1b}", "a\u{7f}", "\u{9f}", "\u{feff}a"] {
            assert_eq!(encode(&["yaml"], StyledValue::Value(&serde_json::json!(text))).unwrap_err().code(), CODEC_ENCODE, "{text:?}");
        }
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

    /// 첫 stage가 `gz`나 `base64`이면 값을 PHP serialize한 뒤 그 stage를 적용한다
    /// (docs/codec.md, `gz`와 `base64`), 그래서 값은 styled value다.
    #[test]
    fn leading_gz_and_base64_serialize_the_value() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let value = serde_json::json!({"a": [1, "x"], "b": null});
        for (stage, serialized) in [("gz", ["serialize", "gz"]), ("base64", ["serialize", "base64"])] {
            let stored = encode(&[stage], StyledValue::Value(&value)).unwrap();
            assert_eq!(stored, encode(&serialized, StyledValue::Value(&value)).unwrap(), "{stage}: stored bytes");
            let raw = match stored {
                Param::Str(s) => Val::Str(s),
                Param::Bytes(b) => Val::Bytes(b),
                other => panic!("{stage}: stored {other:?}"),
            };
            assert_eq!(decode(&[stage.to_string()], &raw).unwrap(), Val::Json(value.clone()), "{stage}: read");
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

    #[test]
    fn styled_column_state_fixture_preserves_stored_values() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let fixture: Value =
            serde_json::from_str(include_str!("../../../../contracts/fixtures/styled_column_states.json")).expect("styled column state fixture");
        let cases = fixture["cases"].as_array().expect("cases array");
        assert_eq!(cases.len(), 13, "every shared styled-column case remains present");
        for case in cases {
            let id = case["id"].as_str().expect("case ID");
            // fixture의 `json`과 `jsons` stage는 dbspec의 `ordered_json` stage다.
            let style = match case["style"].as_str().expect("style") {
                "json" | "jsons" => "ordered_json",
                other => other,
            };
            if id == "unselected" {
                assert_eq!(case["getter_error"].as_str(), Some("COLUMN_UNSELECTED"), "{id}: getter contract");
                assert_eq!(case["requested_output_error"].as_str(), Some("COLUMN_UNSELECTED"), "{id}: output contract");
                continue;
            }
            if id == "nonnull_sql_null" {
                assert_eq!(case["error"].as_str(), Some("CODEC_ENCODE"), "{id}: setter contract");
                continue;
            }
            let raw = match case["stored_text"].as_str() {
                Some(text) => Val::Str(text.into()),
                None => Val::Null,
            };
            let decoded = decode(&[style.into()], &raw);
            if id == "empty_text" {
                assert_eq!(decoded.unwrap_err().code(), CODEC_DECODE, "{id}");
                continue;
            }
            let decoded = decoded.unwrap_or_else(|error| panic!("{id}: {error}"));
            let expected = &case["output"];
            let output = match &decoded {
                Val::Null => serde_json::json!({"kind": "sql-null"}),
                Val::Ordered(value) => serde_json::json!({"kind": "value", "value": crate::value::ordered_to_json(value).unwrap()}),
                Val::Json(value) => serde_json::json!({"kind": "value", "value": value}),
                other => panic!("{id}: unexpected decoded value {other:?}"),
            };
            assert_eq!(&output, expected, "{id}: decoded state");
            if !case["input"].is_object() {
                continue;
            }
            let written = match &decoded {
                Val::Null => encode(&[style], StyledValue::SqlNull).unwrap(),
                Val::Ordered(value) => encode_ordered(&[style], StyledValue::Value(value)).unwrap(),
                Val::Json(value) => encode(&[style], StyledValue::Value(value)).unwrap(),
                _ => unreachable!(),
            };
            if let Some(expected) = case.get("write_text") {
                let expected_write = match expected.as_str() {
                    Some(text) => Param::Str(text.into()),
                    None if expected.is_null() => Param::Null,
                    _ => panic!("{id}: invalid fixture write_text"),
                };
                assert_eq!(written, expected_write, "{id}: stored value");
            } else {
                assert_eq!(style, "yaml", "{id}: only YAML may omit exact write text");
                let encoded = match written {
                    Param::Null => Val::Null,
                    Param::Str(text) => Val::Str(text),
                    other => panic!("{id}: YAML write is not text or SQL NULL: {other:?}"),
                };
                assert_eq!(decode(&[style.into()], &encoded).unwrap(), decoded, "{id}: decoded write");
            }
        }
    }
}
