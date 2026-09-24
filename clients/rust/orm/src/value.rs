//! Parameter and result values.

use chrono::{NaiveDate, NaiveDateTime};

pub type Point = (f64, f64);

pub fn point_text(point: Point) -> crate::Result<String> {
    if !point.0.is_finite() || !point.1.is_finite() {
        return Err(crate::Error::Engine { code: crate::codes::CODEC_ENCODE.into(), msg: "point coordinates must be finite".into() });
    }
    Ok(format!("POINT({} {})", point_number(point.0), point_number(point.1)))
}

pub(crate) fn postgres_point_text(point: Point) -> crate::Result<String> {
    point_text(point)?;
    Ok(format!("({},{})", point_number(point.0), point_number(point.1)))
}

fn point_number(value: f64) -> String {
    if value == 0.0 {
        "0".into()
    } else {
        value.to_string()
    }
}

pub fn parse_point(value: &str) -> crate::Result<Point> {
    let value = value.trim();
    let body = if value.len() >= 7 && value[..6].eq_ignore_ascii_case("POINT(") && value.ends_with(')') {
        &value[6..value.len() - 1]
    } else if value.starts_with('(') && value.ends_with(')') {
        &value[1..value.len() - 1]
    } else {
        value
    };
    let parts: Vec<&str> = body.split(|c: char| c == ',' || c.is_whitespace()).filter(|s| !s.is_empty()).collect();
    if parts.len() != 2 {
        return Err(crate::Error::Engine { code: crate::codes::CODEC_DECODE.into(), msg: format!("point requires two coordinates: {value:?}") });
    }
    let x = parts[0]
        .parse::<f64>()
        .map_err(|_| crate::Error::Engine { code: crate::codes::CODEC_DECODE.into(), msg: format!("point coordinate 0 is invalid: {:?}", parts[0]) })?;
    let y = parts[1]
        .parse::<f64>()
        .map_err(|_| crate::Error::Engine { code: crate::codes::CODEC_DECODE.into(), msg: format!("point coordinate 1 is invalid: {:?}", parts[1]) })?;
    if !x.is_finite() || !y.is_finite() {
        return Err(crate::Error::Engine { code: crate::codes::CODEC_DECODE.into(), msg: "point coordinates must be finite".into() });
    }
    Ok((x, y))
}

#[cfg(test)]
mod point_tests {
    use super::*;

    #[test]
    fn point_conversions_are_strict() {
        assert_eq!(parse_point("POINT(1.25 -2)").unwrap(), (1.25, -2.0));
        assert_eq!(parse_point("(1.25,-2)").unwrap(), (1.25, -2.0));
        assert_eq!(point_text((1.25, -2.0)).unwrap(), "POINT(1.25 -2)");
        assert_eq!(point_text((-0.0, 0.0)).unwrap(), "POINT(0 0)");
        assert_eq!(parse_point("POINT(1)").unwrap_err().code(), crate::codes::CODEC_DECODE);
        assert_eq!(point_text((1.0, f64::NAN)).unwrap_err().code(), crate::codes::CODEC_ENCODE);
    }
}

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
    Point(Point),
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

impl From<Point> for Param {
    fn from(point: Point) -> Self {
        Param::Point(point)
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

/// A value read from a row, positionally. `Ordered` is a column after the `json`
/// or `jsons` stage; `Json` is a column after another style stage (docs/codec.md).
#[derive(Debug, Clone, Default)]
pub enum Val {
    #[default]
    Null,
    I64(i64),
    F64(f64),
    Str(String),
    Bytes(Vec<u8>),
    DateTime(NaiveDateTime),
    Date(NaiveDate),
    Bool(bool),
    Json(serde_json::Value),
    Ordered(ordered_json::Value),
}

/// Ordered-json values are equal when their compact texts are equal.
impl PartialEq for Val {
    fn eq(&self, other: &Val) -> bool {
        match (self, other) {
            (Val::Null, Val::Null) => true,
            (Val::I64(a), Val::I64(b)) => a == b,
            (Val::F64(a), Val::F64(b)) => a == b,
            (Val::Str(a), Val::Str(b)) => a == b,
            (Val::Bytes(a), Val::Bytes(b)) => a == b,
            (Val::DateTime(a), Val::DateTime(b)) => a == b,
            (Val::Date(a), Val::Date(b)) => a == b,
            (Val::Bool(a), Val::Bool(b)) => a == b,
            (Val::Json(a), Val::Json(b)) => a == b,
            (Val::Ordered(a), Val::Ordered(b)) => a.compact() == b.compact(),
            _ => false,
        }
    }
}

impl Val {
    /// An ordered-json value; the JSON null is `Val::Null`.
    pub fn ordered(v: ordered_json::Value) -> Val {
        if v.kind() == ordered_json::Kind::Null {
            Val::Null
        } else {
            Val::Ordered(v)
        }
    }

    /// Moves an ordered-json value out (leaves Null); NULL is the JSON null.
    pub fn take_ordered(&mut self) -> ordered_json::Value {
        match std::mem::take(self) {
            Val::Ordered(v) => v,
            Val::Null => ordered_json::Value::null(),
            other => ordered_json::Value::string(&other.as_string()),
        }
    }

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

    /// Moves a decoded styled value out (leaves Null); Null stays Null.
    pub fn take_json(&mut self) -> Option<serde_json::Value> {
        match self {
            Val::Json(v) => Some(std::mem::take(v)),
            Val::Ordered(v) => Some(ordered_to_json(v)),
            Val::Null => None,
            other => Some(serde_json::Value::String(other.as_string())),
        }
    }

    /// Moves the bytes out (leaves Null).
    pub fn take_bytes(&mut self) -> Vec<u8> {
        match std::mem::take(self) {
            Val::Bytes(b) => b,
            other => other.as_string().into_bytes(),
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
            Val::Json(v) => v.to_string(),
            Val::Ordered(v) => v.compact(),
            Val::Null => String::new(),
        }
    }

    /// The value in array/JSON form (what `to_map()` emits): datetimes as
    /// "YYYY-MM-DD HH:MM:SS.ffffff", bytes as text, decoded styles as they are.
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Val::Null => serde_json::Value::Null,
            Val::I64(x) => serde_json::json!(x),
            Val::F64(x) => serde_json::json!(x),
            Val::Str(s) => serde_json::json!(s),
            Val::Bytes(b) => serde_json::json!(String::from_utf8_lossy(b)),
            Val::DateTime(t) => serde_json::json!(t.format("%Y-%m-%d %H:%M:%S%.6f").to_string()),
            Val::Date(d) => serde_json::json!(d.to_string()),
            Val::Bool(b) => serde_json::json!(b),
            Val::Json(v) => v.clone(),
            Val::Ordered(v) => ordered_to_json(v),
        }
    }

    pub fn as_datetime(&self) -> NaiveDateTime {
        match self {
            Val::DateTime(t) => *t,
            Val::Date(d) => d.and_hms_opt(0, 0, 0).unwrap(),
            Val::Str(s) => {
                NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f").or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")).unwrap_or_default()
            }
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

/// The serde_json form of an ordered-json value (the array form of a row).
pub(crate) fn ordered_to_json(v: &ordered_json::Value) -> serde_json::Value {
    serde_json::from_str(&v.compact()).expect("ordered-json text is valid JSON")
}
