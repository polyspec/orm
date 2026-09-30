//! Strict bounded JSON scanning before generic decoding.
use crate::physical_graph::{error, GraphError, PhysicalGraph};
use serde_json::Value;
use std::collections::HashSet;
const MAX_BYTES: usize = 32 * 1024 * 1024;
struct Scanner<'a> {
    text: &'a [u8],
    pos: usize,
    nodes: usize,
}
impl Scanner<'_> {
    fn peek(&self) -> u8 {
        self.text.get(self.pos).copied().unwrap_or(0)
    }
    fn take(&mut self, c: u8) -> bool {
        if self.peek() != c {
            return false;
        }
        self.pos += 1;
        true
    }
    fn space(&mut self) {
        while matches!(self.peek(), b' ' | b'\r' | b'\n' | b'\t') {
            self.pos += 1;
        }
    }
    fn string(&mut self) -> Result<String, GraphError> {
        let start = self.pos;
        if !self.take(b'"') {
            return Err(error(""));
        }
        while self.pos < self.text.len() {
            let c = self.text[self.pos];
            self.pos += 1;
            if c == b'"' {
                return serde_json::from_slice(&self.text[start..self.pos]).map_err(|_| error(""));
            }
            if c < 32 {
                return Err(error(""));
            }
            if c == b'\\' {
                if self.pos == self.text.len() {
                    return Err(error(""));
                }
                self.pos += 1;
            }
        }
        Err(error(""))
    }
    fn value(&mut self, depth: usize) -> Result<(), GraphError> {
        self.space();
        self.nodes += 1;
        if self.nodes > 3000000 {
            return Err(error(""));
        }
        let c = self.peek();
        if c == b'{' || c == b'[' {
            if depth >= 16 {
                return Err(error(""));
            }
            self.pos += 1;
            let object = c == b'{';
            let close = if object { b'}' } else { b']' };
            let mut keys = HashSet::new();
            self.space();
            if self.take(close) {
                return Ok(());
            }
            loop {
                if object {
                    self.space();
                    if !keys.insert(self.string()?) {
                        return Err(error(""));
                    }
                    self.space();
                    if !self.take(b':') {
                        return Err(error(""));
                    }
                }
                self.value(depth + 1)?;
                self.space();
                if self.take(close) {
                    return Ok(());
                }
                if !self.take(b',') {
                    return Err(error(""));
                }
            }
        }
        if c == b'"' {
            self.string()?;
            return Ok(());
        }
        for literal in [b"true".as_slice(), b"false".as_slice(), b"null".as_slice()] {
            if self.text[self.pos..].starts_with(literal) {
                self.pos += literal.len();
                return Ok(());
            }
        }
        if c == b'-' || c.is_ascii_digit() {
            let start = self.pos;
            while self.pos < self.text.len() && !matches!(self.peek(), b' ' | b'\r' | b'\n' | b'\t' | b',' | b']' | b'}') {
                self.pos += 1;
            }
            if exact_number(&self.text[start..self.pos]) {
                return Ok(());
            }
        }
        Err(error(""))
    }
}
fn exact_number(bytes: &[u8]) -> bool {
    if bytes.len() > 64 {
        return false;
    }
    let Ok(Value::Number(_)) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let normalized = text.trim_start_matches('-').to_ascii_lowercase();
    let mut parts = normalized.split('e');
    let mantissa = parts.next().unwrap();
    let exponent = parts.next().unwrap_or("0");
    let mut pair = mantissa.split('.');
    let whole = pair.next().unwrap();
    let fraction = pair.next().unwrap_or("");
    let joined = format!("{whole}{fraction}");
    let mut digits = joined.trim_start_matches('0').to_owned();
    if digits.is_empty() {
        return true;
    }
    let Ok(exponent) = exponent.parse::<i32>() else {
        return false;
    };
    let shift = exponent as i64 - fraction.len() as i64;
    if !(-64..=64).contains(&shift) {
        return false;
    }
    if shift < 0 {
        let remove = (-shift) as usize;
        if remove > digits.len() || !digits[digits.len() - remove..].bytes().all(|c| c == b'0') {
            return false;
        }
        digits.truncate(digits.len() - remove);
    } else {
        if digits.len() + shift as usize > 16 {
            return false;
        }
        digits.push_str(&"0".repeat(shift as usize));
    }
    digits.len() < 16 || (digits.len() == 16 && digits.as_str() <= "9007199254740991")
}
impl PhysicalGraph {
    pub fn from_json(text: &[u8]) -> Result<Self, GraphError> {
        Self::from_value(decode(text)?)
    }
    pub fn to_json(&self) -> Result<String, GraphError> {
        let text = serde_json::to_string(self.value()).map_err(|_| error(""))?;
        if text.len() > MAX_BYTES {
            return Err(error(""));
        }
        Ok(text)
    }
}
fn decode(text: &[u8]) -> Result<Value, GraphError> {
    if text.len() > MAX_BYTES || std::str::from_utf8(text).is_err() {
        return Err(error(""));
    }
    let mut scan = Scanner { text, pos: 0, nodes: 0 };
    scan.value(0)?;
    scan.space();
    if scan.pos != text.len() {
        return Err(error(""));
    }
    let mut value = serde_json::from_slice(text).map_err(|_| error(""))?;
    normalize_numbers(&mut value);
    Ok(value)
}
#[cfg(test)]
#[path = "../tests/internal/physical_json_limits.rs"]
mod tests;
fn normalize_numbers(value: &mut Value) {
    match value {
        Value::Number(n) => {
            if n.is_f64() {
                *value = Value::from(n.as_f64().expect("preflight safe integer") as i64);
            }
        }
        Value::Array(items) => {
            for item in items {
                normalize_numbers(item);
            }
        }
        Value::Object(items) => {
            for item in items.values_mut() {
                normalize_numbers(item);
            }
        }
        _ => {}
    }
}
