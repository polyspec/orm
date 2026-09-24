//! Column-style codecs (docs/codec.md): json/jsons, serialize, base64, gz, yaml.
//! Styles are listed in write order; `decode` applies them in reverse.

use std::collections::HashSet;
use std::io::{Read, Write};

use base64::Engine as _;
use ordered_json as strict_json;
use serde_json::{Map, Value};
use yaml_rust2::parser::{Event as YamlEvent, MarkedEventReceiver, Parser as YamlParser};
use yaml_rust2::scanner::{Marker as YamlMarker, TScalarStyle};

use crate::codes::{CODEC_DECODE, CODEC_ENCODE, CODEC_UNSUPPORTED};
use crate::value::{Param, Val};
use crate::{Error, Result};

fn err(code: &str, msg: impl Into<String>) -> Error {
    Error::Engine {
        code: code.into(),
        msg: msg.into(),
    }
}

/// Stored cell → decoded value, or `Val::Null` for NULL/empty. The `json` and
/// `jsons` stages return `Val::Ordered`; the other stages return `Val::Json`.
pub fn decode(styles: &[String], raw: &Val) -> Result<Val> {
    let mut cur: Vec<u8> = match raw {
        Val::Null => return Ok(Val::Null),
        // a driver-parsed JSON cell: only a bare json style applies
        Val::Json(v) if styles.len() == 1 && (styles[0] == "json" || styles[0] == "jsons") => {
            v.to_string().into_bytes()
        }
        Val::Str(s) if s.is_empty() => return Ok(Val::Null),
        Val::Str(s) => s.as_bytes().to_vec(),
        Val::Bytes(b) if b.is_empty() => return Ok(Val::Null),
        Val::Bytes(b) => b.clone(),
        other => return Err(err(CODEC_DECODE, format!("cell is {other:?}, not bytes"))),
    };
    let mut value: Option<Val> = None;
    for st in styles.iter().rev() {
        if value.is_some() {
            return Err(err(
                CODEC_DECODE,
                format!("style {st} after a decoded value"),
            ));
        }
        match st.as_str() {
            "gz" => {
                let mut out = Vec::new();
                flate2::read::ZlibDecoder::new(cur.as_slice())
                    .read_to_end(&mut out)
                    .map_err(|e| err(CODEC_DECODE, format!("gz: {e}")))?;
                cur = out;
            }
            "base64" => {
                let text = String::from_utf8_lossy(&cur);
                cur = base64::engine::general_purpose::STANDARD
                    .decode(text.trim())
                    .map_err(|e| err(CODEC_DECODE, format!("base64: {e}")))?;
            }
            "serialize" => value = Some(Val::Json(php_unserialize(&cur)?)),
            "yaml" => {
                validate_yaml_syntax(&cur)?;
                value = Some(Val::Json(
                    serde_yaml_ng::from_slice(&cur)
                        .map_err(|e| err(CODEC_DECODE, format!("yaml: {e}")))?,
                ));
            }
            "json" | "jsons" => {
                value = Some(Val::Ordered(
                    strict_json::parse_bytes(&cur)
                        .map_err(|e| err(CODEC_DECODE, format!("json: {e}")))?,
                ))
            }
            other => return Err(err(CODEC_UNSUPPORTED, format!("style {other}"))),
        }
    }
    Ok(value.unwrap_or_else(|| Val::Str(String::from_utf8_lossy(&cur).into_owned())))
}

/// An ordered-json value → stored representation. The first stage is `json`
/// or `jsons` and writes the compact text of the value; a JSON null is NULL.
pub fn encode_ordered(styles: &[&str], v: &strict_json::Value) -> Result<Param> {
    if v.kind() == strict_json::Kind::Null {
        return Ok(Param::Null);
    }
    match styles.first() {
        Some(&"json") | Some(&"jsons") => finish(&styles[1..], v.compact().into_bytes()),
        _ => Err(err(CODEC_UNSUPPORTED, format!("an ordered-json value needs the first style json, not {styles:?}"))),
    }
}

/// Applies the stages that follow a value stage (base64, gz) to encoded bytes.
fn finish(styles: &[&str], mut cur: Vec<u8>) -> Result<Param> {
    for st in styles {
        match *st {
            "base64" => {
                cur = base64::engine::general_purpose::STANDARD
                    .encode(&cur)
                    .into_bytes()
            }
            "gz" => {
                let mut enc =
                    flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
                enc.write_all(&cur)
                    .map_err(|e| err(CODEC_ENCODE, format!("gz: {e}")))?;
                return Ok(Param::Bytes(
                    enc.finish()
                        .map_err(|e| err(CODEC_ENCODE, format!("gz: {e}")))?,
                ));
            }
            "json" | "jsons" | "serialize" | "yaml" => {
                return Err(err(CODEC_UNSUPPORTED, format!("{st} must be the first style")))
            }
            other => return Err(err(CODEC_UNSUPPORTED, format!("style {other}"))),
        }
    }
    Ok(Param::Str(
        String::from_utf8(cur).map_err(|e| err(CODEC_ENCODE, e.to_string()))?,
    ))
}

/// Value → stored representation as a bind parameter (`Str`, or `Bytes` for gz).
pub fn encode(styles: &[&str], v: Option<&Value>) -> Result<Param> {
    let Some(v) = v else { return Ok(Param::Null) };
    if v.is_null() {
        return Ok(Param::Null);
    }
    let mut cur: Vec<u8> = Vec::new();
    let value = v.clone();
    for (i, st) in styles.iter().enumerate() {
        match *st {
            "serialize" => {
                if i != 0 {
                    return Err(err(
                        CODEC_UNSUPPORTED,
                        "serialize must be the first encoding style",
                    ));
                }
                let mut s = String::new();
                php_serialize(&mut s, &value)?;
                cur = s.into_bytes();
            }
            "yaml" => {
                if i != 0 {
                    return Err(err(CODEC_UNSUPPORTED, "yaml must be the first style"));
                }
                cur = serde_yaml_ng::to_string(&value)
                    .map_err(|e| err(CODEC_ENCODE, format!("yaml: {e}")))?
                    .into_bytes();
            }
            "json" | "jsons" => {
                if i != 0 {
                    return Err(err(CODEC_UNSUPPORTED, "json must be the first style"));
                }
                let raw = serde_json::to_vec(&value)
                    .map_err(|e| err(CODEC_ENCODE, format!("json: {e}")))?;
                let parsed = strict_json::parse_bytes(&raw)
                    .map_err(|e| err(CODEC_ENCODE, format!("json: {e}")))?;
                cur = strict_json::stringify(&parsed).into_bytes();
            }
            "base64" => {
                cur = base64::engine::general_purpose::STANDARD
                    .encode(&cur)
                    .into_bytes()
            }
            "gz" => {
                let mut enc =
                    flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
                enc.write_all(&cur)
                    .map_err(|e| err(CODEC_ENCODE, format!("gz: {e}")))?;
                return Ok(Param::Bytes(
                    enc.finish()
                        .map_err(|e| err(CODEC_ENCODE, format!("gz: {e}")))?,
                ));
            }
            other => return Err(err(CODEC_UNSUPPORTED, format!("style {other}"))),
        }
    }
    Ok(Param::Str(
        String::from_utf8(cur).map_err(|e| err(CODEC_ENCODE, e.to_string()))?,
    ))
}

enum YamlFrame {
    Sequence,
    Mapping {
        expecting_key: bool,
        keys: HashSet<String>,
    },
}

#[derive(Default)]
struct YamlValidator {
    documents: usize,
    frames: Vec<YamlFrame>,
    error: Option<String>,
}

impl YamlValidator {
    fn fail(&mut self, mark: YamlMarker, message: impl AsRef<str>) {
        if self.error.is_none() {
            self.error = Some(format!(
                "{} at line {}, column {}",
                message.as_ref(),
                mark.line(),
                mark.col()
            ));
        }
    }

    fn start_node(&mut self, key: Option<(&str, TScalarStyle)>, mark: YamlMarker) {
        if let Some(YamlFrame::Mapping {
            expecting_key,
            keys,
        }) = self.frames.last_mut()
        {
            if *expecting_key {
                let Some((key, style)) = key else {
                    self.fail(mark, "map keys must be scalar strings");
                    return;
                };
                let lower = key.to_ascii_lowercase();
                let non_string_plain = style == TScalarStyle::Plain
                    && (matches!(lower.as_str(), "true" | "false" | "null" | "~")
                        || ((key.contains('.') || key.contains('e') || key.contains('E'))
                            && key.parse::<f64>().is_ok()));
                if non_string_plain {
                    self.fail(
                        mark,
                        "plain boolean, null, and floating-point map keys are not supported",
                    );
                    return;
                }
                if !keys.insert(key.to_string()) {
                    self.fail(mark, format!("duplicate map key {key:?}"));
                    return;
                }
                *expecting_key = false;
            } else {
                *expecting_key = true;
            }
        }
    }
}

impl MarkedEventReceiver for YamlValidator {
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
            YamlEvent::Scalar(value, style, anchor, tag) => {
                if anchor != 0 {
                    self.fail(mark, "anchors are not supported");
                } else if tag.is_some() {
                    self.fail(mark, "explicit tags are not supported");
                } else if style == TScalarStyle::Plain
                    && matches!(
                        value.to_ascii_lowercase().as_str(),
                        ".inf" | "+.inf" | "-.inf" | ".nan"
                    )
                {
                    self.fail(mark, "non-finite numbers are not supported");
                } else {
                    self.start_node(Some((&value, style)), mark);
                }
            }
            YamlEvent::SequenceStart(anchor, tag) => {
                if anchor != 0 || tag.is_some() {
                    self.fail(mark, "anchors and explicit tags are not supported");
                    return;
                }
                self.start_node(None, mark);
                self.frames.push(YamlFrame::Sequence);
            }
            YamlEvent::MappingStart(anchor, tag) => {
                if anchor != 0 || tag.is_some() {
                    self.fail(mark, "anchors and explicit tags are not supported");
                    return;
                }
                self.start_node(None, mark);
                self.frames.push(YamlFrame::Mapping {
                    expecting_key: true,
                    keys: HashSet::new(),
                });
            }
            YamlEvent::SequenceEnd | YamlEvent::MappingEnd => {
                self.frames.pop();
            }
            _ => {}
        }
    }
}

fn validate_yaml_syntax(bytes: &[u8]) -> Result<()> {
    let source = std::str::from_utf8(bytes)
        .map_err(|e| err(CODEC_DECODE, format!("yaml: invalid UTF-8: {e}")))?;
    let mut validator = YamlValidator::default();
    YamlParser::new_from_str(source)
        .load(&mut validator, true)
        .map_err(|e| err(CODEC_DECODE, format!("yaml: {e}")))?;
    match validator.error {
        Some(message) => Err(err(CODEC_DECODE, format!("yaml: {message}"))),
        None => Ok(()),
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
    if k.is_empty()
        || k == "-0"
        || (k.len() > 1 && k.starts_with('0'))
        || (k.len() > 2 && k.starts_with("-0"))
    {
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
    let mant = if mant.contains('.') {
        mant.to_string()
    } else {
        format!("{mant}.0")
    };
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
        let j = rest
            .iter()
            .position(|&x| x == c)
            .ok_or_else(|| self.fail(&format!("expected {}", c as char)))?;
        let s = std::str::from_utf8(&rest[..j]).map_err(|_| self.fail("bad utf-8"))?;
        self.i += j + 1;
        Ok(s)
    }

    fn value(&mut self) -> Result<Value> {
        let t = *self
            .b
            .get(self.i)
            .ok_or_else(|| self.fail("unexpected end"))?;
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
                    b'b' => Ok(Value::Bool(s == "1")),
                    b'i' => s
                        .parse::<i64>()
                        .map(Value::from)
                        .map_err(|_| self.fail("bad int")),
                    _ => {
                        let f = match s {
                            "INF" => f64::INFINITY,
                            "-INF" => f64::NEG_INFINITY,
                            "NAN" => f64::NAN,
                            _ => s.parse::<f64>().map_err(|_| self.fail("bad float"))?,
                        };
                        Ok(serde_json::Number::from_f64(f)
                            .map(Value::Number)
                            .unwrap_or(Value::Null))
                    }
                }
            }
            b's' => {
                self.expect(b':')?;
                let n: usize = self
                    .until(b':')?
                    .parse()
                    .map_err(|_| self.fail("bad string length"))?;
                self.expect(b'"')?;
                if self.i + n > self.b.len() {
                    return Err(self.fail("string overruns input"));
                }
                let s = String::from_utf8(self.b[self.i..self.i + n].to_vec())
                    .map_err(|_| self.fail("string is not utf-8"))?;
                self.i += n;
                self.expect(b'"')?;
                self.expect(b';')?;
                Ok(Value::String(s))
            }
            b'a' => {
                self.expect(b':')?;
                let n: usize = self
                    .until(b':')?
                    .parse()
                    .map_err(|_| self.fail("bad array length"))?;
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
            b'O' | b'C' | b'r' | b'R' => Err(err(
                CODEC_UNSUPPORTED,
                format!(
                    "serialize: objects and references are not supported ({})",
                    t as char
                ),
            )),
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
            out.push(StyledCol {
                index: c.index,
                codec,
                host,
            });
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
    let (host, codec): (Vec<String>, Vec<String>) =
        styles.iter().cloned().partition(|s| is_host(s));
    (codec, host)
}

fn is_host(style: &str) -> bool {
    matches!(style, "aes" | "hex" | "ip" | "blind_index")
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
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key.as_bytes())
        .map_err(|_| Error::Config("invalid blind_index key".into()))?;
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
    let encrypted = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plain,
                aad: AES_V2_PREFIX,
            },
        )
        .expect("AES-GCM encryption");
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
        .decrypt(
            &nonce,
            Payload {
                msg: &cipher_text[offset + 12..],
                aad: AES_V2_PREFIX,
            },
        )
        .map_err(|_| err(CODEC_DECODE, "aes: authentication failed"))
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

/// `UNHEX(...)`: either case; whitespace around the text is ignored.
pub fn hex_decode(s: &str) -> Result<Vec<u8>> {
    let s = s.trim().as_bytes();
    if !s.len().is_multiple_of(2) {
        return Err(err(CODEC_DECODE, "hex: odd length"));
    }
    let nibble = |c: u8| -> Result<u8> {
        match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            b'A'..=b'F' => Ok(c - b'A' + 10),
            _ => Err(err(CODEC_DECODE, format!("hex: invalid byte {c:#x}"))),
        }
    };
    s.as_chunks::<2>().0.iter()
        .map(|p| Ok(nibble(p[0])? << 4 | nibble(p[1])?))
        .collect()
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
        Param::Point(p) => crate::point_text(*p)?.into_bytes(),
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
            "ip" => pack_ip(
                std::str::from_utf8(&cur).map_err(|e| err(CODEC_ENCODE, format!("ip: {e}")))?,
            )?,
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
            "hex" => hex_decode(&String::from_utf8_lossy(&cur))?,
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
                Some(f) if n.as_i64().is_none() && f.fract() == 0.0 && f.abs() < 9.0e15 => {
                    Value::from(f as i64)
                }
                _ => v.clone(),
            },
            Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
            Value::Object(m) => {
                Value::Object(m.iter().map(|(k, x)| (k.clone(), norm(x))).collect())
            }
            _ => v.clone(),
        }
    }

    /// Every PHP-produced vector decodes to the same value; deterministic styles re-encode
    /// to the same bytes. Rust's encodings go to tests/codec/out/rust.json for the PHP cross-check.
    #[test]
    fn vectors() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../tests/codec");
        let src = std::fs::read(format!("{root}/vectors.json")).expect("vectors.json");
        let f: serde_json::Map<String, Value> = serde_json::from_slice(&src).unwrap();
        let vectors: Vec<Vector> = serde_json::from_value(f["vectors"].clone()).unwrap();
        let mut out = Map::new();
        let mut fails = 0;
        for v in &vectors {
            let raw = match &v.encoded_b64 {
                None => Val::Null,
                Some(b) => Val::Bytes(base64::engine::general_purpose::STANDARD.decode(b).unwrap()),
            };
            let decoded = decode(&v.styles, &raw);
            let got = match &decoded {
                Ok(Val::Json(j)) => j.clone(),
                Ok(Val::Ordered(o)) => crate::value::ordered_to_json(o),
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
                Ok(Val::Ordered(o)) => encode_ordered(&styles, o).unwrap(),
                _ => encode(&styles, Some(&got)).unwrap(),
            };
            let enc_b64 = match &enc {
                Param::Null => None,
                Param::Str(s) => {
                    Some(base64::engine::general_purpose::STANDARD.encode(s.as_bytes()))
                }
                Param::Bytes(b) => Some(base64::engine::general_purpose::STANDARD.encode(b)),
                _ => unreachable!(),
            };
            out.insert(
                v.name.clone(),
                enc_b64.clone().map(Value::String).unwrap_or(Value::Null),
            );
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
                Ok(Val::Ordered(o)) if norm(&crate::value::ordered_to_json(&o)) == norm(&v.value) => {}
                Ok(Val::Null) if v.value.is_null() => {}
                other => {
                    fails += 1;
                    eprintln!("{}: round trip {:?}", v.name, other);
                }
            }
        }
        std::fs::create_dir_all(format!("{root}/out")).unwrap();
        std::fs::write(
            format!("{root}/out/rust.json"),
            serde_json::to_string_pretty(&Value::Object(out)).unwrap(),
        )
        .unwrap();
        assert_eq!(fails, 0);
    }

    /// AES v2 uses an authenticated envelope and rejects tampering.
    #[test]
    fn aes_vectors() {
        let styles = vec!["aes".to_string(), "hex".to_string()];
        let encoded =
            host_encode(&Param::Str("member@example.test".into()), &styles, "key-v1").unwrap();
        let Param::Str(encoded) = encoded else {
            panic!("AES+hex must produce text")
        };
        assert_eq!(
            host_decode(&Val::Str(encoded.clone()), &styles, "key-v1").unwrap(),
            Val::Str("member@example.test".into())
        );
        let mut tampered = hex_decode(&encoded).unwrap();
        *tampered.last_mut().unwrap() ^= 1;
        assert_eq!(
            host_decode(&Val::Str(hex_upper(&tampered)), &styles, "key-v1")
                .unwrap_err()
                .code(),
            CODEC_DECODE
        );
        assert_eq!(
            host_encode(&Param::Null, &styles, "key-v1").unwrap(),
            Param::Null
        );
        let fixed = hex_decode("4F524D2D414553320000112233445566778899AABB651DA9F08BE2FA7CD7B2DF5C04D91B32189DCD854A70762F99271A2BEBA64A248E24").unwrap();
        assert_eq!(
            host_decode(&Val::Str(hex_upper(&fixed)), &styles, "bench-salt").unwrap(),
            Val::Str("user42@example.com".into())
        );
    }

    #[test]
    fn blind_index_vector() {
        assert_eq!(
            blind_index(&Param::Str("member@example.test".into()), "blind-key").unwrap(),
            "1992d5622b305dec915751bc7382d3c0ed9e130f2cc62ab3560e244953160fa8"
        );
    }

    #[test]
    fn errors_and_keys() {
        for (styles, raw, code) in [
            (vec!["json"], "{bad", "CODEC_DECODE"),
            (
                vec!["serialize"],
                "O:8:\"stdClass\":0:{}",
                "CODEC_UNSUPPORTED",
            ),
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
        match encode(&["serialize"], Some(&v)).unwrap() {
            Param::Str(s) => assert_eq!(
                s,
                "a:5:{i:-3;i:2;s:2:\"07\";i:1;i:10;i:3;s:1:\"x\";d:4;s:1:\"y\";d:1.0E+25;}"
            ),
            other => panic!("{other:?}"),
        }
        assert_eq!(
            encode(&["curlfile"], Some(&serde_json::json!({})))
                .unwrap_err()
                .code(),
            CODEC_UNSUPPORTED
        );
        assert_eq!(
            encode(&["serialize", "yaml"], Some(&serde_json::json!({})))
                .unwrap_err()
                .code(),
            CODEC_UNSUPPORTED
        );
        let yaml = vec!["yaml".to_string()];
        assert_eq!(
            decode(&yaml, &Val::Str("1: value\n".into())).unwrap(),
            Val::Json(serde_json::json!({"1": "value"}))
        );
    }

    /// The json stage returns the ordered-json value with its member order,
    /// number text, and {} apart from []; the write keeps the same text.
    #[test]
    fn json_stage_keeps_ordered_json() {
        let text = r#"{"b":1,"a":[],"c":{},"n":1.50}"#;
        for styles in [vec!["json"], vec!["jsons"], vec!["json", "gz"], vec!["json", "base64"]] {
            let value = strict_json::parse(text).unwrap();
            let stored = encode_ordered(&styles, &value).unwrap();
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
        assert_eq!(encode_ordered(&["json"], &strict_json::Value::null()).unwrap(), Param::Null);
        assert_eq!(encode_ordered(&["serialize"], &strict_json::parse("{}").unwrap()).unwrap_err().code(), CODEC_UNSUPPORTED);
        assert_eq!(decode(&["json".to_string()], &Val::Str("{".into())).unwrap_err().code(), CODEC_DECODE);
    }
}
