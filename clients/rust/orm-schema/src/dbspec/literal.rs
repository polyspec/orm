//! Literal validation and the canonical literal forms.

use super::model::Type;

/// A literal as written: a signed number, a word or a string value.
#[derive(Clone, Debug)]
pub(crate) enum Value {
    Number { negative: bool, text: String },
    Word(String),
    Str(String),
}

/// Splits number text into its integer digits without leading zeros (empty for
/// zero) and its fraction digits.
fn split_number(text: &str) -> (&str, &str) {
    let (int, frac) = text.split_once('.').unwrap_or((text, ""));
    (int.trim_start_matches('0'), frac)
}

/// The canonical string literal: single quotes, a quote written as `''`.
pub(crate) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Validates a default value against its column type and returns its canonical text.
pub(crate) fn default_literal(ty: Type, value: &Value) -> Result<String, String> {
    let ty_text = ty.render();
    let unfit = || format!("default does not fit {ty_text}");
    match (ty, value) {
        (Type::I16 | Type::I32 | Type::I64, Value::Number { negative, text }) => {
            if text.contains('.') {
                return Err(unfit());
            }
            let (min, max): (i128, i128) = match ty {
                Type::I16 => (i16::MIN as i128, i16::MAX as i128),
                Type::I32 => (i32::MIN as i128, i32::MAX as i128),
                _ => (i64::MIN as i128, i64::MAX as i128),
            };
            let digits = text.trim_start_matches('0');
            if digits.len() > 20 {
                return Err(unfit());
            }
            let magnitude: i128 = if digits.is_empty() { 0 } else { digits.parse().map_err(|_| unfit())? };
            let number = if *negative { -magnitude } else { magnitude };
            if number < min || number > max {
                return Err(unfit());
            }
            Ok(number.to_string())
        }
        (Type::Decimal(p, s), Value::Number { negative, text }) => {
            let (int, frac) = split_number(text);
            let (s, p) = (s as usize, p as usize);
            if int.len() > p - s {
                return Err(unfit());
            }
            if frac.len() > s {
                return Err(unfit());
            }
            let mut fraction: String = frac.chars().take(s).collect();
            while fraction.len() < s {
                fraction.push('0');
            }
            let int = if int.is_empty() { "0" } else { int };
            let zero = int == "0" && fraction.bytes().all(|b| b == b'0');
            let sign = if *negative && !zero { "-" } else { "" };
            Ok(if s == 0 { format!("{sign}{int}") } else { format!("{sign}{int}.{fraction}") })
        }
        (Type::F64, Value::Number { negative, text }) => {
            // Rust's `Display` writes the shortest decimal that reads back as
            // the same value, without an exponent.
            let parsed: f64 = format!("{}{text}", if *negative { "-" } else { "" }).parse().map_err(|_| unfit())?;
            if !parsed.is_finite() {
                return Err(unfit());
            }
            Ok(if parsed == 0.0 { "0".into() } else { parsed.to_string() })
        }
        (Type::Bool, Value::Word(word)) if matches!(word.as_str(), "true" | "false") => Ok(word.clone()),
        (Type::Varchar(n), Value::Str(text)) => {
            if text.contains('\0') || text.chars().count() > n as usize {
                return Err(unfit());
            }
            Ok(quote(text))
        }
        (Type::Uuid, Value::Str(text)) => {
            let lower = text.to_ascii_lowercase();
            let shape =
                lower.len() == 36 && lower.bytes().enumerate().all(|(i, b)| if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() });
            if !shape {
                return Err(unfit());
            }
            Ok(quote(&lower))
        }
        (Type::Date, Value::Str(text)) => {
            if !valid_date(text) {
                return Err(unfit());
            }
            Ok(quote(text))
        }
        (Type::Time(p), Value::Str(text)) => Ok(quote(&time(text, p).ok_or_else(unfit)?)),
        (Type::DateTime(_), Value::Word(word)) if word == "now" => Ok("now".into()),
        (Type::DateTime(p), Value::Str(text)) => {
            let (date, clock) = text.split_once(' ').ok_or_else(unfit)?;
            if !valid_date(date) {
                return Err(unfit());
            }
            Ok(quote(&format!("{date} {}", time(clock, p).ok_or_else(unfit)?)))
        }
        _ => Err(unfit()),
    }
}

/// Validates a check literal against the column it meets and returns its
/// canonical text: the default literal of the column type, where a `text`
/// column takes the `varchar` form without a length limit and `now` is not a
/// literal.
pub(crate) fn check_literal(ty: Type, value: &Value) -> Result<String, String> {
    let fits = match (ty, value) {
        (Type::Text, Value::Str(text)) if !text.contains('\0') => Ok(quote(text)),
        (Type::Text, _) | (Type::DateTime(_), Value::Word(_)) => Err(()),
        _ => default_literal(ty, value).map_err(|_| ()),
    };
    fits.map_err(|()| format!("literal {} does not fit {}", value.written(), ty.render()))
}

impl Value {
    /// The literal as written, for messages.
    pub fn written(&self) -> String {
        match self {
            Value::Number { negative, text } => format!("{}{text}", if *negative { "-" } else { "" }),
            Value::Word(word) => word.clone(),
            Value::Str(text) => quote(text),
        }
    }
}

fn digits(text: &str, count: usize) -> Option<u32> {
    if text.len() == count && text.bytes().all(|b| b.is_ascii_digit()) {
        text.parse().ok()
    } else {
        None
    }
}

/// `YYYY-MM-DD` from 0001-01-01 to 9999-12-31.
fn valid_date(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    let [y, m, d] = parts[..] else { return false };
    let (Some(year), Some(month), Some(day)) = (digits(y, 4), digits(m, 2), digits(d, 2)) else { return false };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    year >= 1 && day >= 1 && day <= days
}

/// `HH:MM:SS[.f]` below 24:00:00 written with exactly `p` fraction digits.
/// More fraction digits than `p` do not fit.
fn time(text: &str, p: u8) -> Option<String> {
    let (clock, frac) = match text.split_once('.') {
        Some((clock, frac)) if !frac.is_empty() && frac.bytes().all(|b| b.is_ascii_digit()) => (clock, frac),
        Some(_) => return None,
        None => (text, ""),
    };
    let parts: Vec<&str> = clock.split(':').collect();
    let [h, m, s] = parts[..] else { return None };
    let (hour, minute, second) = (digits(h, 2)?, digits(m, 2)?, digits(s, 2)?);
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let p = p as usize;
    if frac.len() > p {
        return None;
    }
    let mut fraction: String = frac.chars().take(p).collect();
    while fraction.len() < p {
        fraction.push('0');
    }
    Some(if p == 0 { clock.to_owned() } else { format!("{clock}.{fraction}") })
}
