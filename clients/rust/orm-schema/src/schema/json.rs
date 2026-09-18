//! A JSON writer with the output of Go's encoding/json: fields in declaration
//! order, HTML-safe string escaping, and `MarshalIndent` layout with two
//! spaces. The manifest hash is computed over the compact form.

/// A JSON value with ordered object members.
pub enum J {
    Null,
    Bool(bool),
    Int(i64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

/// Builds an object while applying `omitempty`.
#[derive(Default)]
pub struct Obj(Vec<(String, J)>);

impl Obj {
    pub fn new() -> Obj {
        Obj(Vec::new())
    }
    pub fn put(mut self, key: &str, v: J) -> Obj {
        self.0.push((key.to_owned(), v));
        self
    }
    pub fn str(self, key: &str, v: &str) -> Obj {
        self.put(key, J::Str(v.to_owned()))
    }
    pub fn str_omit(self, key: &str, v: &str) -> Obj {
        if v.is_empty() {
            self
        } else {
            self.str(key, v)
        }
    }
    pub fn bool_omit(self, key: &str, v: bool) -> Obj {
        if v {
            self.put(key, J::Bool(true))
        } else {
            self
        }
    }
    pub fn int_omit(self, key: &str, v: i64) -> Obj {
        if v == 0 {
            self
        } else {
            self.put(key, J::Int(v))
        }
    }
    pub fn strs(self, key: &str, v: &[String]) -> Obj {
        self.put(key, strs(v))
    }
    pub fn strs_omit(self, key: &str, v: &[String]) -> Obj {
        if v.is_empty() {
            self
        } else {
            self.strs(key, v)
        }
    }
    pub fn done(self) -> J {
        J::Obj(self.0)
    }
}

pub fn strs(v: &[String]) -> J {
    J::Arr(v.iter().map(|s| J::Str(s.clone())).collect())
}

/// Writes a Go string literal as encoding/json does with HTML escaping.
fn write_str(out: &mut String, s: &str) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '<' | '>' | '&' => {
                let b = ch as u8;
                out.push_str("\\u00");
                out.push(HEX[(b >> 4) as usize] as char);
                out.push(HEX[(b & 0xf) as usize] as char);
            }
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => {
                let b = c as u8;
                out.push_str("\\u00");
                out.push(HEX[(b >> 4) as usize] as char);
                out.push(HEX[(b & 0xf) as usize] as char);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The compact form of `json.Marshal`.
pub fn compact(v: &J) -> String {
    let mut out = String::new();
    write(&mut out, v, None, 0);
    out
}

/// The form of `json.MarshalIndent(v, "", "  ")`.
pub fn indent(v: &J) -> String {
    let mut out = String::new();
    write(&mut out, v, Some("  "), 0);
    out
}

fn newline(out: &mut String, unit: Option<&str>, depth: usize) {
    if let Some(unit) = unit {
        out.push('\n');
        for _ in 0..depth {
            out.push_str(unit);
        }
    }
}

fn write(out: &mut String, v: &J, unit: Option<&str>, depth: usize) {
    match v {
        J::Null => out.push_str("null"),
        J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        J::Int(n) => out.push_str(&n.to_string()),
        J::Str(s) => write_str(out, s),
        J::Arr(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, unit, depth + 1);
                write(out, item, unit, depth + 1);
            }
            newline(out, unit, depth);
            out.push(']');
        }
        J::Obj(members) => {
            if members.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (k, item)) in members.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, unit, depth + 1);
                write_str(out, k);
                out.push(':');
                if unit.is_some() {
                    out.push(' ');
                }
                write(out, item, unit, depth + 1);
            }
            newline(out, unit, depth);
            out.push('}');
        }
    }
}
