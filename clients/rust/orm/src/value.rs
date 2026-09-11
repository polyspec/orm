//! Parameter and result values.

use chrono::{NaiveDate, NaiveDateTime};

/// A bound parameter. Generated code converts typed arguments into this.
#[derive(Debug, Clone, PartialEq)]
pub enum Param {
    Null,
    Bool(bool),
    I64(i64),
    F64(f64),
    Str(String),
    Bytes(Vec<u8>),
    DateTime(NaiveDateTime),
    Date(NaiveDate),
}

macro_rules! from_param {
    ($($t:ty => $v:ident),* $(,)?) => { $( impl From<$t> for Param { fn from(x: $t) -> Self { Param::$v(x.into()) } } )* };
}
from_param!(bool => Bool, i32 => I64, i64 => I64, u32 => I64, f64 => F64, String => Str, Vec<u8> => Bytes, NaiveDateTime => DateTime, NaiveDate => Date);

impl From<&str> for Param {
    fn from(s: &str) -> Self {
        Param::Str(s.to_owned())
    }
}

impl From<u64> for Param {
    fn from(x: u64) -> Self {
        Param::I64(x as i64)
    }
}

impl<T: Into<Param>> From<Option<T>> for Param {
    fn from(o: Option<T>) -> Self {
        match o {
            Some(v) => v.into(),
            None => Param::Null,
        }
    }
}

/// A value read from a row, positionally.
#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    Null,
    I64(i64),
    F64(f64),
    Str(String),
    Bytes(Vec<u8>),
    DateTime(NaiveDateTime),
    Date(NaiveDate),
    Bool(bool),
}

impl Val {
    pub fn is_null(&self) -> bool {
        matches!(self, Val::Null)
    }

    pub fn as_i64(&self) -> i64 {
        match self {
            Val::I64(x) => *x,
            Val::F64(x) => *x as i64,
            Val::Bool(b) => *b as i64,
            Val::Str(s) => s.parse().unwrap_or(0),
            _ => 0,
        }
    }

    pub fn as_f64(&self) -> f64 {
        match self {
            Val::F64(x) => *x,
            Val::I64(x) => *x as f64,
            Val::Str(s) => s.parse().unwrap_or(0.0),
            _ => 0.0,
        }
    }

    pub fn as_bool(&self) -> bool {
        match self {
            Val::Bool(b) => *b,
            Val::I64(x) => *x != 0,
            Val::Str(s) => s == "1" || s == "true",
            _ => false,
        }
    }

    /// Moves the string out (leaves Null) — avoids a clone when the row is consumed.
    pub fn take_string(&mut self) -> String {
        match self {
            Val::Str(s) => std::mem::take(s),
            other => other.as_string(),
        }
    }

    pub fn as_string(&self) -> String {
        match self {
            Val::Str(s) => s.clone(),
            Val::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
            Val::I64(x) => x.to_string(),
            Val::F64(x) => x.to_string(),
            Val::Bool(b) => (*b as i64).to_string(),
            Val::DateTime(t) => t.format("%Y-%m-%d %H:%M:%S%.6f").to_string(),
            Val::Date(d) => d.to_string(),
            Val::Null => String::new(),
        }
    }

    pub fn as_datetime(&self) -> NaiveDateTime {
        match self {
            Val::DateTime(t) => *t,
            Val::Date(d) => d.and_hms_opt(0, 0, 0).unwrap(),
            Val::Str(s) => NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f")
                .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S"))
                .unwrap_or_default(),
            _ => NaiveDateTime::default(),
        }
    }

    pub fn as_date(&self) -> NaiveDate {
        match self {
            Val::Date(d) => *d,
            Val::DateTime(t) => t.date(),
            Val::Str(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap_or_default(),
            _ => NaiveDate::default(),
        }
    }
}

/// Executor-side value transforms; identical in Go/PHP.
pub fn transform(kind: &str, s: &str) -> String {
    match kind {
        "fulltext_boolean" => {
            let t = s.trim();
            if t.is_empty() {
                String::new()
            } else {
                format!("+{}*", t.replace(' ', " +"))
            }
        }
        "like_contains" => format!("%{}%", esc(s)),
        "like_starts" => format!("{}%", esc(s)),
        "like_ends" => format!("%{}", esc(s)),
        _ => s.to_owned(),
    }
}

fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}
