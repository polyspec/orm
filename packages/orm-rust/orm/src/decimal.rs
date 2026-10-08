//! Exact decimal field values.

fn invalid(input: &str, reason: &str) -> crate::Error {
    crate::Error::Engine { code: crate::codes::CODEC_ENCODE.into(), msg: format!("decimal {input:?}: {reason}") }
}

/// Validate a decimal field value and pad it to its declared scale.
pub fn normalize(input: &str, precision: u8, scale: u8) -> crate::Result<String> {
    if !(1..=18).contains(&precision) || scale > precision {
        return Err(invalid(input, "invalid precision or scale"));
    }
    let (negative, unsigned) = if let Some(value) = input.strip_prefix('-') {
        (true, value)
    } else if let Some(value) = input.strip_prefix('+') {
        (false, value)
    } else {
        (false, input)
    };
    let mut parts = unsigned.split('.');
    let whole_text = parts.next().unwrap_or("");
    let fraction = parts.next().unwrap_or("");
    if whole_text.is_empty()
        || parts.next().is_some()
        || (!fraction.is_empty() && scale == 0)
        || !whole_text.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        || unsigned.ends_with('.')
    {
        return Err(invalid(input, "invalid text"));
    }
    if fraction.len() > usize::from(scale) {
        return Err(invalid(input, "fraction exceeds scale"));
    }
    let whole = whole_text.trim_start_matches('0');
    let whole = if whole.is_empty() { "0" } else { whole };
    let whole_digits = if whole == "0" { 0 } else { whole.len() };
    if whole_digits + usize::from(scale) > usize::from(precision) {
        return Err(invalid(input, "value exceeds precision"));
    }
    let padded = format!("{fraction:0<width$}", width = usize::from(scale));
    let negative = negative && !(whole == "0" && padded.bytes().all(|byte| byte == b'0'));
    let sign = if negative { "-" } else { "" };
    if scale == 0 {
        Ok(format!("{sign}{whole}"))
    } else {
        Ok(format!("{sign}{whole}.{padded}"))
    }
}

/// Bind a decimal to SQLite without a floating-point conversion.
pub fn scaled(input: &str, precision: u8, scale: u8) -> crate::Result<i64> {
    let canonical = normalize(input, precision, scale)?;
    canonical.replace('.', "").parse::<i64>().map_err(|error| invalid(input, &format!("scaled integer overflow: {error}")))
}

/// Decode an exact decimal result cell from SQL text or a SQLite scaled integer.
pub fn decode(value: crate::Val, precision: u8, scale: u8) -> crate::Result<String> {
    let text = match value {
        crate::Val::Str(text) => text,
        crate::Val::I64(value) => {
            let negative = value < 0;
            let mut digits = value.unsigned_abs().to_string();
            if scale > 0 {
                let width = usize::from(scale) + 1;
                if digits.len() < width {
                    digits = format!("{digits:0>width$}");
                }
                let cut = digits.len() - usize::from(scale);
                digits.insert(cut, '.');
            }
            if negative {
                format!("-{digits}")
            } else {
                digits
            }
        }
        other => return Err(crate::Error::Engine { code: crate::codes::CODEC_DECODE.into(), msg: format!("decimal cell has invalid type {other:?}") }),
    };
    normalize(&text, precision, scale)
        .map_err(|error| crate::Error::Engine { code: crate::codes::CODEC_DECODE.into(), msg: format!("invalid decimal cell: {error}") })
}
