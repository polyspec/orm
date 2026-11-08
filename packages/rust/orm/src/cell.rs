//! The cells that a column type holds, as every client reads them (COD-1): one message per column type, which names
//! neither the host type nor the value (INT-163).

use chrono::{NaiveDate, NaiveDateTime, NaiveTime, Timelike};
use polyspec_orm_schema::dbspec::Type;

use crate::value::Val;
use crate::{codes, Error, Result};

/// The message of a cell that its column type does not hold, one per column type in every client (COD-1).
pub(crate) fn cell_message(column_type: &str) -> String {
    match column_type {
        "i16" | "i32" | "i64" => format!("{column_type} cell is not an exact integer in its range"),
        "f64" => "f64 cell is not a finite number".into(),
        "bool" => "bool cell is not boolean".into(),
        "decimal" => "decimal cell is not a decimal of its precision and scale".into(),
        "date" | "datetime" | "time" => format!("{column_type} cell is not a {column_type}"),
        "bytes" => "bytes cell is not bytes".into(),
        other => format!("{other} cell is not text"),
    }
}

/// The CODEC_DECODE of a cell that its column type does not hold (COD-1).
pub(crate) fn cell_refusal(column_type: &str) -> Error {
    Error::Engine { code: codes::CODEC_DECODE.into(), msg: cell_message(column_type), source: None }
}

/// The CODEC_DECODE of a cell that its column type does not hold, keeping the failure that found it (COD-1).
pub(crate) fn cell_refusal_by(column_type: &str, cause: impl std::error::Error + Send + Sync + 'static) -> Error {
    Error::Engine { code: codes::CODEC_DECODE.into(), msg: cell_message(column_type), source: Some(Box::new(cause)) }
}

/// The refusal of a text cell whose bytes are not UTF-8 (COD-69), which keeps the failure of the UTF-8 read.
pub(crate) fn invalid_utf8(cause: impl std::error::Error + Send + Sync + 'static) -> Error {
    Error::Engine { code: codes::CODEC_DECODE.into(), msg: "text is not valid UTF-8".into(), source: Some(Box::new(cause)) }
}

fn digits(bytes: &[u8]) -> bool {
    !bytes.is_empty() && bytes.iter().all(u8::is_ascii_digit)
}

/// The exact digits of an integer: no sign but a minus and no leading zero, in the i64 range.
pub(crate) fn exact_integer(text: &[u8]) -> Option<i64> {
    let (negative, body) = match text {
        [b'-', body @ ..] => (true, body),
        body => (false, body),
    };
    if !digits(body) || (body.len() > 1 && body[0] == b'0') {
        return None;
    }
    // The digits accumulate as a negative number, whose range holds i64::MIN.
    let mut n: i64 = 0;
    for d in body {
        n = n.checked_mul(10)?.checked_sub(i64::from(d - b'0'))?;
    }
    if negative {
        Some(n)
    } else {
        n.checked_neg()
    }
}

/// An integer cell in [low, high]: an integer, a float with no fraction, the exact digits of an integer that a text
/// protocol sends as bytes, and, when `text` is true, a stored text of those exact digits. A boolean is no integer
/// cell, as in every client (COD-1).
pub(crate) fn integer_cell(value: &Val, low: i64, high: i64, text: bool) -> Option<i64> {
    let n = match value {
        Val::I64(n) => *n,
        Val::F64(x) if x.is_finite() && x.trunc() == *x && *x >= -9_223_372_036_854_775_808.0 && *x < 9_223_372_036_854_775_808.0 => *x as i64,
        Val::Bytes(bytes) => exact_integer(bytes)?,
        Val::Str(s) if text => exact_integer(s.as_bytes())?,
        _ => return None,
    };
    (low..=high).contains(&n).then_some(n)
}

/// The range of an integer column type.
pub(crate) fn integer_range(column_type: &str) -> (i64, i64) {
    match column_type {
        "i16" => (i64::from(i16::MIN), i64::from(i16::MAX)),
        "i32" => (i64::from(i32::MIN), i64::from(i32::MAX)),
        _ => (i64::MIN, i64::MAX),
    }
}

/// The decimal text of a number that an f64 cell may hold: `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`.
fn decimal_number(b: &[u8]) -> bool {
    let mut i = usize::from(b.first() == Some(&b'-'));
    let start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == start || (i - start > 1 && b[start] == b'0') {
        return false;
    }
    if i < b.len() && b[i] == b'.' {
        let fraction = i + 1;
        i = fraction;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == fraction {
            return false;
        }
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let exponent = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == exponent {
            return false;
        }
    }
    i == b.len()
}

/// The number of a decimal text, or None for another text. Rust reads every decimal text as an f64, rounding it to the
/// nearest one and a text past the f64 range to an infinity, which the caller refuses.
fn decimal_f64(text: &[u8]) -> Option<f64> {
    if !decimal_number(text) {
        return None;
    }
    let ascii: String = text.iter().map(|b| char::from(*b)).collect();
    Some(ascii.parse().expect("Rust reads every decimal text as an f64"))
}

/// An f64 cell: a finite number, or the decimal text of one (COD-1).
pub(crate) fn f64_cell(value: &Val) -> Option<f64> {
    let x = match value {
        Val::F64(x) => *x,
        Val::I64(n) => *n as f64,
        Val::Str(s) => decimal_f64(s.as_bytes())?,
        Val::Bytes(bytes) => decimal_f64(bytes)?,
        _ => return None,
    };
    x.is_finite().then_some(x)
}

/// A bool cell: a boolean, the integer 0 or 1, or the text 0, 1, f, t, false or true (COD-1).
pub(crate) fn bool_cell(value: &Val) -> Option<bool> {
    let text = match value {
        Val::Bool(b) => return Some(*b),
        Val::I64(0) => return Some(false),
        Val::I64(1) => return Some(true),
        Val::Str(s) => s.as_bytes(),
        Val::Bytes(bytes) => bytes.as_slice(),
        _ => return None,
    };
    match text {
        b"1" | b"t" | b"true" => Some(true),
        b"0" | b"f" | b"false" => Some(false),
        _ => None,
    }
}

fn number(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0, |n, d| n * 10 + u32::from(d - b'0'))
}

/// The text YYYY-MM-DD of a real day of the proleptic Gregorian calendar.
fn date_text(text: &[u8]) -> Option<NaiveDate> {
    if text.len() != 10 || text[4] != b'-' || text[7] != b'-' || !digits(&text[..4]) || !digits(&text[5..7]) || !digits(&text[8..]) {
        return None;
    }
    // Four digits are at most 9999, which an i32 holds.
    NaiveDate::from_ymd_opt(number(&text[..4]) as i32, number(&text[5..7]), number(&text[8..]))
}

/// A date cell: a date that the driver read, or the text YYYY-MM-DD of a real day (COD-1).
pub(crate) fn date_cell(value: &Val) -> Option<NaiveDate> {
    match value {
        Val::Date(d) => Some(*d),
        Val::Str(s) => date_text(s.as_bytes()),
        Val::Bytes(bytes) => date_text(bytes),
        _ => None,
    }
}

/// A clock read from the start of a text: the hours, minutes, seconds and fraction digits, and the rest of the text.
struct Clock<'a> {
    h: u32,
    m: u32,
    s: u32,
    fraction: &'a [u8],
    rest: &'a [u8],
}

/// HH:MM:SS with an optional fraction of one to nine digits, in the clock range.
fn clock(text: &[u8]) -> Option<Clock<'_>> {
    if text.len() < 8 || text[2] != b':' || text[5] != b':' || !digits(&text[..2]) || !digits(&text[3..5]) || !digits(&text[6..8]) {
        return None;
    }
    let (h, m, s) = (number(&text[..2]), number(&text[3..5]), number(&text[6..8]));
    if h > 23 || m > 59 || s > 59 {
        return None;
    }
    let mut rest = &text[8..];
    let mut fraction: &[u8] = &[];
    if let [b'.', tail @ ..] = rest {
        let n = tail.iter().take_while(|d| d.is_ascii_digit()).count();
        if n == 0 || n > 9 {
            return None;
        }
        fraction = &tail[..n];
        rest = &tail[n..];
    }
    Some(Clock { h, m, s, fraction, rest })
}

/// The fraction of a clock cut to p digits; None when a cut digit is not zero, since the cell would lose value.
fn fraction_digits(fraction: &[u8], precision: u8) -> Option<String> {
    let p = usize::from(precision);
    if fraction.iter().skip(p).any(|d| *d != b'0') {
        return None;
    }
    let mut kept: String = fraction.iter().take(p).map(|d| char::from(*d)).collect();
    while kept.len() < p {
        kept.push('0');
    }
    Some(kept)
}

/// A time(p) cell as HH:MM:SS text with exactly p fraction digits (COD-1, DIA-24).
pub(crate) fn time_cell(value: &Val, precision: u8) -> Option<String> {
    let text = match value {
        Val::Str(s) => s.as_bytes(),
        Val::Bytes(bytes) => bytes.as_slice(),
        _ => return None,
    };
    let Clock { h, m, s, fraction, rest } = clock(text)?;
    if !rest.is_empty() {
        return None;
    }
    let kept = fraction_digits(fraction, precision)?;
    Some(if kept.is_empty() { format!("{h:02}:{m:02}:{s:02}") } else { format!("{h:02}:{m:02}:{s:02}.{kept}") })
}

/// The offset in seconds of `Z`, `±HH`, `±HHMM` or `±HH:MM`.
fn offset_seconds(zone: &[u8]) -> Option<i64> {
    let (sign, body) = match zone {
        [b'Z'] => return Some(0),
        [b'+', body @ ..] => (1, body),
        [b'-', body @ ..] => (-1, body),
        _ => return None,
    };
    let minutes = match body {
        [h1, h2] if digits(&[*h1, *h2]) => number(&[*h1, *h2]) * 60,
        [h1, h2, b':', m1, m2] | [h1, h2, m1, m2] if digits(&[*h1, *h2, *m1, *m2]) => number(&[*h1, *h2]) * 60 + number(&[*m1, *m2]),
        _ => return None,
    };
    Some(sign * i64::from(minutes) * 60)
}

/// A datetime(p) cell: a datetime that the driver read, or the text YYYY-MM-DD HH:MM:SS (or with T) of a real instant
/// with an optional fraction and offset, as UTC. A fraction digit beyond p that is not zero loses value, so the cell is
/// refused (COD-1).
pub(crate) fn datetime_cell(value: &Val, precision: u8) -> Option<NaiveDateTime> {
    let text = match value {
        Val::DateTime(t) => return (t.nanosecond() % 10u32.pow(9 - u32::from(precision.min(9))) == 0).then_some(*t),
        Val::Str(s) => s.as_bytes(),
        Val::Bytes(bytes) => bytes.as_slice(),
        _ => return None,
    };
    if text.len() < 19 || !(text[10] == b' ' || text[10] == b'T') {
        return None;
    }
    let day = date_text(&text[..10])?;
    let Clock { h, m, s, fraction, rest } = clock(&text[11..])?;
    fraction_digits(fraction, precision)?;
    let nanos = fraction.iter().chain(std::iter::repeat(&b'0')).take(9).fold(0u32, |n, d| n * 10 + u32::from(d - b'0'));
    let wall = day.and_time(NaiveTime::from_hms_nano_opt(h, m, s, nanos)?);
    let zone = rest.trim_ascii_start();
    if zone.is_empty() {
        return Some(wall);
    }
    wall.checked_sub_signed(chrono::Duration::seconds(offset_seconds(zone)?))
}

/// The cell of a declared model column as the value its column type holds, or the refusal of its type (COD-1, COD-69).
/// A declared integer column refuses a stored text, which only a text protocol's bytes may carry.
pub(crate) fn declared_cell(ty: &Type, value: Val) -> Result<Val> {
    if matches!(value, Val::Null) {
        return Ok(value);
    }
    let name = ty.name();
    let refused = || cell_refusal(name);
    Ok(match ty {
        Type::I16 | Type::I32 | Type::I64 => {
            let (low, high) = integer_range(name);
            Val::I64(integer_cell(&value, low, high, false).ok_or_else(refused)?)
        }
        Type::F64 => Val::F64(f64_cell(&value).ok_or_else(refused)?),
        Type::Bool => Val::Bool(bool_cell(&value).ok_or_else(refused)?),
        Type::Date => Val::Date(date_cell(&value).ok_or_else(refused)?),
        Type::DateTime(p) => Val::DateTime(datetime_cell(&value, *p).ok_or_else(refused)?),
        Type::Time(p) => Val::Str(time_cell(&value, *p).ok_or_else(refused)?),
        Type::Varchar(_) | Type::Text | Type::Uuid => match value {
            Val::Str(s) => Val::Str(s),
            Val::Bytes(bytes) => Val::Str(String::from_utf8(bytes).map_err(invalid_utf8)?),
            _ => return Err(refused()),
        },
        Type::Bytes => match value {
            Val::Bytes(bytes) => Val::Bytes(bytes),
            Val::Str(s) => Val::Bytes(s.into_bytes()),
            _ => return Err(refused()),
        },
        Type::Decimal(..) => value,
    })
}

/// The cell of an added column by the type its plan column states (INT-160): an integer takes the exact digits of a
/// stored text too, a datetime has six fraction digits, and another type keeps the driver value.
pub(crate) fn added_cell(column_type: &str, value: Val) -> Result<Val> {
    if matches!(value, Val::Null) {
        return Ok(value);
    }
    let refused = || cell_refusal(column_type);
    Ok(match column_type {
        "i16" | "i32" | "i64" => {
            let (low, high) = integer_range(column_type);
            Val::I64(integer_cell(&value, low, high, true).ok_or_else(refused)?)
        }
        "f64" => Val::F64(f64_cell(&value).ok_or_else(refused)?),
        "bool" => Val::Bool(bool_cell(&value).ok_or_else(refused)?),
        "date" => Val::Date(date_cell(&value).ok_or_else(refused)?),
        "datetime" => Val::DateTime(datetime_cell(&value, 6).ok_or_else(refused)?),
        _ => value,
    })
}
