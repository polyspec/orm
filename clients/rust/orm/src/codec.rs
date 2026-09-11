//! Column-style codecs (docs/codec.md): json/jsons, serialize, base64, gz.
//! Styles are listed in write order; `decode` applies them in reverse.

use std::io::{Read, Write};

use base64::Engine as _;
use serde_json::{Map, Value};

use crate::value::{Param, Val};
use crate::{Error, Result};

fn err(code: &str, msg: impl Into<String>) -> Error {
    Error::Engine { code: code.into(), msg: msg.into() }
}

/// Stored cell → JSON-like value (`Val::Json`), or `Val::Null` for NULL/empty.
pub fn decode(styles: &[String], raw: &Val) -> Result<Val> {
    let mut cur: Vec<u8> = match raw {
        Val::Null => return Ok(Val::Null),
        // already parsed by the driver (MySQL JSON column): only a bare json style applies
        Val::Json(v) if styles.len() == 1 && (styles[0] == "json" || styles[0] == "jsons") => return Ok(Val::Json(v.clone())),
        Val::Str(s) if s.is_empty() => return Ok(Val::Null),
        Val::Str(s) => s.as_bytes().to_vec(),
        Val::Bytes(b) if b.is_empty() => return Ok(Val::Null),
        Val::Bytes(b) => b.clone(),
        other => return Err(err("CODEC_DECODE", format!("cell is {other:?}, not bytes"))),
    };
    let mut value: Option<Value> = None;
    for st in styles.iter().rev() {
        if value.is_some() {
            return Err(err("CODEC_DECODE", format!("style {st} after a decoded value")));
        }
        match st.as_str() {
            "gz" => {
                let mut out = Vec::new();
                flate2::read::ZlibDecoder::new(cur.as_slice()).read_to_end(&mut out).map_err(|e| err("CODEC_DECODE", format!("gz: {e}")))?;
                cur = out;
            }
            "base64" => {
                let text = String::from_utf8_lossy(&cur);
                cur = base64::engine::general_purpose::STANDARD.decode(text.trim()).map_err(|e| err("CODEC_DECODE", format!("base64: {e}")))?;
            }
            "serialize" => value = Some(php_unserialize(&cur)?),
            "json" | "jsons" => value = Some(serde_json::from_slice(&cur).map_err(|e| err("CODEC_DECODE", format!("json: {e}")))?),
            other => return Err(err("CODEC_UNSUPPORTED", format!("style {other}"))),
        }
    }
    Ok(match value {
        Some(v) => Val::Json(v),
        None => Val::Str(String::from_utf8_lossy(&cur).into_owned()),
    })
}

/// Value → stored representation as a bind parameter (`Str`, or `Bytes` for gz).
pub fn encode(styles: &[&str], v: Option<&Value>) -> Result<Param> {
    let Some(v) = v else { return Ok(Param::Null) };
    if v.is_null() {
        return Ok(Param::Null);
    }
    let mut cur: Vec<u8> = Vec::new();
    for (i, st) in styles.iter().enumerate() {
        match *st {
            "serialize" => {
                if i != 0 {
                    return Err(err("CODEC_UNSUPPORTED", "serialize must be the first style"));
                }
                let mut s = String::new();
                php_serialize(&mut s, v)?;
                cur = s.into_bytes();
            }
            "json" | "jsons" => {
                if i != 0 {
                    return Err(err("CODEC_UNSUPPORTED", "json must be the first style"));
                }
                cur = serde_json::to_vec(v).map_err(|e| err("CODEC_ENCODE", format!("json: {e}")))?;
            }
            "base64" => cur = base64::engine::general_purpose::STANDARD.encode(&cur).into_bytes(),
            "gz" => {
                let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
                enc.write_all(&cur).map_err(|e| err("CODEC_ENCODE", format!("gz: {e}")))?;
                return Ok(Param::Bytes(enc.finish().map_err(|e| err("CODEC_ENCODE", format!("gz: {e}")))?));
            }
            other => return Err(err("CODEC_UNSUPPORTED", format!("style {other}"))),
        }
    }
    Ok(Param::Str(String::from_utf8(cur).map_err(|e| err("CODEC_ENCODE", e.to_string()))?))
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
                return Err(err("CODEC_ENCODE", format!("number {n} out of range")));
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
        err("CODEC_DECODE", format!("serialize: {msg} at {}", self.i))
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
                    b'b' => Ok(Value::Bool(s == "1")),
                    b'i' => s.parse::<i64>().map(Value::from).map_err(|_| self.fail("bad int")),
                    _ => {
                        let f = match s {
                            "INF" => f64::INFINITY,
                            "-INF" => f64::NEG_INFINITY,
                            "NAN" => f64::NAN,
                            _ => s.parse::<f64>().map_err(|_| self.fail("bad float"))?,
                        };
                        Ok(serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null))
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
            b'O' | b'C' | b'r' | b'R' => Err(err("CODEC_UNSUPPORTED", format!("serialize: objects and references are not supported ({})", t as char))),
            other => Err(self.fail(&format!("unknown type {}", other as char))),
        }
    }
}

/// Positional columns of a step that need decoding (joins included).
pub fn styled_cols(a: &crate::plan::Assemble) -> Vec<(usize, Vec<String>)> {
    let mut out = Vec::new();
    for c in &a.columns {
        if !c.styles.is_empty() {
            out.push((c.index, c.styles.clone()));
        }
    }
    for ch in &a.children {
        if let Some(ja) = &ch.assemble {
            out.extend(styled_cols(ja));
        }
    }
    out
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
            let got = match decode(&v.styles, &raw) {
                Ok(Val::Json(j)) => j,
                Ok(Val::Null) => Value::Null,
                other => { fails += 1; eprintln!("{}: decode {:?}", v.name, other); continue; }
            };
            if norm(&got) != norm(&v.value) {
                fails += 1;
                eprintln!("{}: decoded {got} want {}", v.name, v.value);
            }
            let styles: Vec<&str> = v.styles.iter().map(String::as_str).collect();
            let enc = encode(&styles, Some(&got)).unwrap();
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
            let back_raw = match enc { Param::Null => Val::Null, Param::Str(s) => Val::Str(s), Param::Bytes(b) => Val::Bytes(b), _ => unreachable!() };
            match decode(&v.styles, &back_raw) {
                Ok(Val::Json(j)) if norm(&j) == norm(&v.value) => {}
                Ok(Val::Null) if v.value.is_null() => {}
                other => { fails += 1; eprintln!("{}: round trip {:?}", v.name, other); }
            }
        }
        std::fs::create_dir_all(format!("{root}/out")).unwrap();
        std::fs::write(format!("{root}/out/rust.json"), serde_json::to_string_pretty(&Value::Object(out)).unwrap()).unwrap();
        assert_eq!(fails, 0);
    }

    #[test]
    fn errors_and_keys() {
        for (styles, raw, code) in [
            (vec!["json"], "{bad", "CODEC_DECODE"),
            (vec!["serialize"], "O:8:\"stdClass\":0:{}", "CODEC_UNSUPPORTED"),
            (vec!["serialize"], "a:1:{i:0;", "CODEC_DECODE"),
            (vec!["serialize", "gz"], "not zlib", "CODEC_DECODE"),
            (vec!["serialize", "base64"], "@@@", "CODEC_DECODE"),
        ] {
            let styles: Vec<String> = styles.into_iter().map(String::from).collect();
            match decode(&styles, &Val::Str(raw.into())) {
                Err(e) => assert_eq!(e.code(), code, "{raw}"),
                Ok(v) => panic!("{raw}: {v:?}"),
            }
        }
        let v: Value = serde_json::json!({"07": 1, "-3": 2, "10": 3, "x": 4.0, "y": 1e25});
        match encode(&["serialize"], Some(&v)).unwrap() {
            Param::Str(s) => assert_eq!(s, "a:5:{i:-3;i:2;s:2:\"07\";i:1;i:10;i:3;s:1:\"x\";d:4;s:1:\"y\";d:1.0E+25;}"),
            other => panic!("{other:?}"),
        }
    }
}
