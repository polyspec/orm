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

#[cfg(test)]
mod checked_value_tests {
    use super::*;

    #[test]
    fn invalid_or_lossy_values_report_decode_errors() {
        let bad_integers = [Val::Str("not-a-number".into()), Val::Str("9223372036854775808".into()), Val::F64(1.5), Val::F64(f64::NAN), Val::Null];
        for value in bad_integers {
            assert_eq!(value.as_i64().unwrap_err().code(), crate::codes::CODEC_DECODE, "{value:?}");
        }
        for value in [Val::Str("NaN".into()), Val::Str("0.1".into()), Val::Str("9007199254740993".into()), Val::F64(f64::INFINITY), Val::I64((1i64 << 53) + 1)]
        {
            assert_eq!(value.as_f64().unwrap_err().code(), crate::codes::CODEC_DECODE, "{value:?}");
        }
        for value in [Val::Str("perhaps".into()), Val::I64(2), Val::Null] {
            assert_eq!(value.as_bool().unwrap_err().code(), crate::codes::CODEC_DECODE, "{value:?}");
        }
        assert_eq!(Val::Str("2026-02-30".into()).as_date().unwrap_err().code(), crate::codes::CODEC_DECODE);
        assert_eq!(Val::Str("bad time".into()).as_datetime().unwrap_err().code(), crate::codes::CODEC_DECODE);
        assert_eq!(Val::Date(chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()).as_datetime().unwrap_err().code(), crate::codes::CODEC_DECODE);
        assert_eq!(Val::F64(f64::NAN).to_json().unwrap_err().code(), crate::codes::CODEC_DECODE);
        assert_eq!(Val::Point((f64::NAN, 0.0)).to_json().unwrap_err().code(), crate::codes::CODEC_ENCODE);
        assert_eq!(Val::Bytes(vec![0xff]).as_string().unwrap_err().code(), crate::codes::CODEC_DECODE);
        assert_eq!(Val::Null.as_string().unwrap_err().code(), crate::codes::CODEC_DECODE);
        let mut wrong = Val::I64(7);
        assert_eq!(wrong.take_bytes().unwrap_err().code(), crate::codes::CODEC_DECODE);
        assert_eq!(wrong, Val::I64(7));
        assert_eq!(wrong.take_ordered().unwrap_err().code(), crate::codes::CODEC_DECODE);
        assert_eq!(wrong, Val::I64(7));
        assert_eq!(Val::Null.take_ordered().unwrap_err().code(), crate::codes::CODEC_DECODE);
        let mut text = Val::Str(String::new());
        assert_eq!(text.take_string().unwrap(), "");
        assert_eq!(text, Val::Null);
        let mut json = Val::Json(serde_json::json!({}));
        assert_eq!(json.take_json().unwrap(), Some(serde_json::json!({})));
        assert_eq!(json, Val::Null);
        let literal_null = ordered_json::Value::null();
        assert_eq!(Val::ordered(literal_null.clone()), Val::Ordered(literal_null));
        assert_ne!(Val::ordered(ordered_json::Value::null()), Val::Null);
        assert_eq!(Param::try_from(u64::MAX).unwrap_err().code(), crate::codes::CODEC_ENCODE);
        assert_eq!(transform("unknown", "input").unwrap_err().code(), crate::codes::CONFIG);
    }

    #[test]
    fn aggregate_numbers_follow_shared_binary64_cases_without_changing_checked_values() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../../contracts/fixtures/aggregate_numeric.json")).expect("aggregate fixture");
        assert_eq!(fixture["feature"], "model_queries");
        let cases = fixture["cases"].as_array().expect("aggregate cases");
        assert_eq!(cases.len(), 9);
        assert_eq!(Val::Str("48.0450".into()).as_f64().unwrap_err().code(), crate::codes::CODEC_DECODE);
        for case in cases {
            let id = case["id"].as_str().expect("case id");
            assert_eq!(case["operation"], "aggregate_numeric", "{id}");
            let value = match case["input_type"].as_str().expect("input type") {
                "decimal_text" | "integer_text" => Val::Str(case["input"].as_str().expect("numeric text").into()),
                "null" => {
                    assert!(case["input"].is_null(), "{id}");
                    Val::Null
                }
                other => panic!("{id}: unsupported input type {other}"),
            };
            match (case["expected"]["bits"].as_str(), case["expected"]["error"].as_str()) {
                (Some(bits), None) => {
                    let expected = u64::from_str_radix(bits, 16).expect("binary64 bits");
                    let number = value.as_aggregate_f64().unwrap_or_else(|error| panic!("{id}: {error}"));
                    assert!(number.is_finite(), "{id}");
                    assert_eq!(number.to_bits(), expected, "{id}");
                }
                (None, Some("CODEC_DECODE")) => assert_eq!(value.as_aggregate_f64().unwrap_err().code(), crate::codes::CODEC_DECODE, "{id}"),
                other => panic!("{id}: invalid expected result {other:?}"),
            }
        }
        assert_eq!(Val::I64((1i64 << 53) + 1).as_aggregate_f64().unwrap().to_bits(), 0x4340_0000_0000_0000);
        assert_eq!(Val::F64(f64::INFINITY).as_aggregate_f64().unwrap_err().code(), crate::codes::CODEC_DECODE);
        assert_eq!(Val::Bool(true).as_aggregate_f64().unwrap_err().code(), crate::codes::CODEC_DECODE);
        assert_eq!(Val::Bytes(b"48.0450".to_vec()).as_aggregate_f64().unwrap_err().code(), crate::codes::CODEC_DECODE);
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

impl TryFrom<u64> for Param {
    type Error = crate::Error;

    fn try_from(x: u64) -> crate::Result<Self> {
        i64::try_from(x)
            .map(Param::I64)
            .map_err(|_| crate::Error::Engine { code: crate::codes::CODEC_ENCODE.into(), msg: "unsigned integer exceeds i64 range".into() })
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

/// A selected styled column, with SQL NULL separate from the decoded value.
#[derive(Debug, Clone, PartialEq)]
pub enum StyledValue<T> {
    SqlNull,
    Value(T),
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
    Point(Point),
    Json(serde_json::Value),
    Ordered(ordered_json::Value),
}

fn decode_value(message: impl Into<String>) -> crate::Error {
    crate::Error::Engine { code: crate::codes::CODEC_DECODE.into(), msg: message.into() }
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
            (Val::Point(a), Val::Point(b)) => a == b,
            (Val::Json(a), Val::Json(b)) => a == b,
            (Val::Ordered(a), Val::Ordered(b)) => a.compact() == b.compact(),
            _ => false,
        }
    }
}

impl Val {
    /// An ordered-json value, including a JSON literal null.
    pub fn ordered(v: ordered_json::Value) -> Val {
        Val::Ordered(v)
    }

    /// Moves an ordered-json value out (leaves Null); SQL NULL is not ordered JSON.
    pub fn take_ordered(&mut self) -> crate::Result<ordered_json::Value> {
        match self {
            Val::Ordered(_) => {
                let Val::Ordered(value) = std::mem::replace(self, Val::Null) else { unreachable!() };
                Ok(value)
            }
            other => Err(decode_value(format!("expected ordered JSON, received {other:?}"))),
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Val::Null)
    }

    pub fn as_i64(&self) -> crate::Result<i64> {
        match self {
            Val::I64(x) => Ok(*x),
            Val::F64(x) if x.is_finite() && x.fract() == 0.0 && *x >= i64::MIN as f64 && *x < 9_223_372_036_854_775_808.0 => Ok(*x as i64),
            Val::Bool(b) => Ok(i64::from(*b)),
            Val::Str(s) => s.parse().map_err(|_| decode_value(format!("invalid i64: {s:?}"))),
            other => Err(decode_value(format!("expected i64, received {other:?}"))),
        }
    }

    pub fn as_i32(&self) -> crate::Result<i32> {
        i32::try_from(self.as_i64()?).map_err(|_| decode_value("integer is outside i32 range"))
    }

    pub fn as_point(&self) -> crate::Result<Point> {
        match self {
            Val::Point(point) => {
                point_text(*point)?;
                Ok(*point)
            }
            Val::Str(text) => parse_point(text),
            other => Err(decode_value(format!("expected point, received {other:?}"))),
        }
    }

    pub fn as_f64(&self) -> crate::Result<f64> {
        match self {
            Val::F64(x) if x.is_finite() => Ok(*x),
            Val::I64(x) if x.unsigned_abs() <= (1u64 << 53) => Ok(*x as f64),
            Val::Str(s) => {
                let value = s.parse::<f64>().ok().filter(|x| x.is_finite()).ok_or_else(|| decode_value(format!("invalid finite f64: {s:?}")))?;
                let exact =
                    if s.contains('e') || s.contains('E') { rust_decimal::Decimal::from_scientific(s) } else { rust_decimal::Decimal::from_str_exact(s) }
                        .map_err(|_| decode_value(format!("decimal cannot be checked for exact f64 conversion: {s:?}")))?;
                if rust_decimal::Decimal::from_f64_retain(value) != Some(exact) {
                    return Err(decode_value(format!("decimal loses precision as f64: {s:?}")));
                }
                Ok(value)
            }
            other => Err(decode_value(format!("expected finite f64, received {other:?}"))),
        }
    }

    /// Convert a numeric database aggregate to finite binary64. Aggregate terminals return
    /// an approximate floating result; ordinary value conversion remains lossless.
    pub(crate) fn as_aggregate_f64(&self) -> crate::Result<f64> {
        match self {
            Val::F64(value) if value.is_finite() => Ok(*value),
            Val::I64(value) => Ok(*value as f64),
            Val::Str(text) => {
                text.parse::<f64>().ok().filter(|value| value.is_finite()).ok_or_else(|| decode_value(format!("invalid finite aggregate number: {text:?}")))
            }
            other => Err(decode_value(format!("expected a finite aggregate number, received {other:?}"))),
        }
    }

    pub fn as_bool(&self) -> crate::Result<bool> {
        match self {
            Val::Bool(b) => Ok(*b),
            Val::I64(0) => Ok(false),
            Val::I64(1) => Ok(true),
            Val::Str(s) if s == "0" || s == "false" => Ok(false),
            Val::Str(s) if s == "1" || s == "true" => Ok(true),
            other => Err(decode_value(format!("expected boolean, received {other:?}"))),
        }
    }

    /// Moves a decoded styled value out (leaves Null); Null stays Null.
    pub fn take_json(&mut self) -> crate::Result<Option<serde_json::Value>> {
        match self {
            Val::Json(_) => {
                let Val::Json(value) = std::mem::replace(self, Val::Null) else { unreachable!() };
                Ok(Some(value))
            }
            Val::Null => Ok(None),
            other => Err(decode_value(format!("expected JSON, received {other:?}"))),
        }
    }

    pub fn into_json(mut self) -> crate::Result<serde_json::Value> {
        self.take_json()?.ok_or_else(|| decode_value("non-null JSON column received NULL"))
    }

    /// Moves the bytes out (leaves Null).
    pub fn take_bytes(&mut self) -> crate::Result<Vec<u8>> {
        match self {
            Val::Bytes(_) => {
                let Val::Bytes(value) = std::mem::replace(self, Val::Null) else { unreachable!() };
                Ok(value)
            }
            Val::Str(_) => {
                let Val::Str(value) = std::mem::replace(self, Val::Null) else { unreachable!() };
                Ok(value.into_bytes())
            }
            other => Err(decode_value(format!("expected bytes, received {other:?}"))),
        }
    }

    /// Moves the string out (leaves Null) — avoids a clone when the row is consumed.
    pub fn take_string(&mut self) -> crate::Result<String> {
        match self {
            Val::Str(_) => {
                let Val::Str(value) = std::mem::replace(self, Val::Null) else { unreachable!() };
                Ok(value)
            }
            other => Err(decode_value(format!("expected string, received {other:?}"))),
        }
    }

    pub fn as_string(&self) -> crate::Result<String> {
        Ok(match self {
            Val::Str(s) => s.clone(),
            Val::Bytes(b) => std::str::from_utf8(b).map_err(|_| decode_value("bytes are not UTF-8"))?.to_owned(),
            Val::I64(x) => x.to_string(),
            Val::F64(x) if x.is_finite() => x.to_string(),
            Val::Bool(b) => (*b as i64).to_string(),
            Val::Point(point) => point_text(*point)?,
            Val::DateTime(t) => t.format("%Y-%m-%d %H:%M:%S%.6f").to_string(),
            Val::Date(d) => d.to_string(),
            Val::Json(v) => v.to_string(),
            Val::Ordered(v) => v.compact(),
            other => return Err(decode_value(format!("expected text value, received {other:?}"))),
        })
    }

    /// The value in array form: datetimes as "YYYY-MM-DD HH:MM:SS.ffffff",
    /// bytes as text, decoded styles as they are. An ordered-json value that
    /// serde_json cannot represent returns CODEC_ENCODE.
    pub fn to_json(&self) -> crate::Result<serde_json::Value> {
        Ok(match self {
            Val::Null => serde_json::Value::Null,
            Val::I64(x) => serde_json::json!(x),
            Val::F64(x) if x.is_finite() => serde_json::json!(x),
            Val::F64(_) => return Err(decode_value("non-finite f64 cannot be JSON")),
            Val::Str(s) => serde_json::json!(s),
            Val::Bytes(b) => serde_json::json!(std::str::from_utf8(b).map_err(|_| decode_value("bytes are not UTF-8"))?),
            Val::DateTime(t) => serde_json::json!(t.format("%Y-%m-%d %H:%M:%S%.6f").to_string()),
            Val::Date(d) => serde_json::json!(d.to_string()),
            Val::Bool(b) => serde_json::json!(b),
            Val::Point(point) => serde_json::json!(point_text(*point)?),
            Val::Json(v) => v.clone(),
            Val::Ordered(v) => ordered_to_json(v)?,
        })
    }

    pub fn as_datetime(&self) -> crate::Result<NaiveDateTime> {
        match self {
            Val::DateTime(t) => Ok(*t),
            Val::Str(s) => NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f")
                .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S"))
                .map_err(|_| decode_value(format!("invalid datetime: {s:?}"))),
            other => Err(decode_value(format!("expected datetime, received {other:?}"))),
        }
    }

    pub fn as_date(&self) -> crate::Result<NaiveDate> {
        match self {
            Val::Date(d) => Ok(*d),
            Val::Str(s) => NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| decode_value(format!("invalid date: {s:?}"))),
            other => Err(decode_value(format!("expected date, received {other:?}"))),
        }
    }
}

/// Executor-side value transforms.
pub fn transform(kind: &str, s: &str) -> crate::Result<String> {
    Ok(match kind {
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
        _ => return Err(crate::Error::Config(format!("unknown value transform {kind}"))),
    })
}

fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// The serde_json form of an ordered-json value (the array form of a row).
/// A number outside the serde_json range, such as 1e400, returns CODEC_ENCODE.
pub(crate) fn ordered_to_json(v: &ordered_json::Value) -> crate::Result<serde_json::Value> {
    serde_json::from_str(&v.compact())
        .map_err(|e| crate::Error::Engine { code: crate::codes::CODEC_ENCODE.into(), msg: format!("json: the value has no serde_json form: {e}") })
}
