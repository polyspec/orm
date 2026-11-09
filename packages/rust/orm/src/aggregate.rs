//! The sum and the average of a column (DSL-66, DSL-161, DIA-200).

use polyspec_orm_schema::dbspec::Type;

use crate::value::Val;
use crate::{codes, Error, Result};

/// The text of every refused sum or average scalar in every client (DSL-66).
pub(crate) const REFUSED: &str = "aggregate scalar is not a finite number";

/// The decimal places that the average of an exact column keeps beyond the scale of the column (DSL-161).
const AVG_SCALE_EXTRA: u32 = 16;

pub(crate) fn refused() -> Error {
    Error::Engine { code: codes::CODEC_DECODE.into(), msg: REFUSED.into(), source: None }
}

/// The scale of an exact column (DSL-161): 0 for an integer column and S for a `decimal(P,S)` column; None for an `f64` column.
fn exact_scale(ty: &Type) -> Option<u32> {
    match ty {
        Type::I16 | Type::I32 | Type::I64 => Some(0),
        Type::Decimal(_, scale) => Some(u32::from(*scale)),
        _ => None,
    }
}

/// The sum cell of an exact column as its sign and the digits of the sum × 10^scale: an integer cell is that integer (SQLite
/// and markdown store a decimal so, DIA-25), a text cell is a decimal of at most scale fraction digits.
fn exact_digits(value: &Val, scale: u32) -> Result<(bool, String)> {
    let (negative, whole, fraction) = match value {
        Val::I64(n) => (*n < 0, n.unsigned_abs().to_string(), String::new()),
        Val::Str(text) => {
            let (negative, body) = text.strip_prefix('-').map_or((false, text.as_str()), |rest| (true, rest));
            let (whole, fraction) = body.split_once('.').map_or((body, None), |(w, f)| (w, Some(f)));
            let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
            if !digits(whole) || fraction.is_some_and(|f| !digits(f)) {
                return Err(refused());
            }
            let fraction = fraction.unwrap_or_default();
            if fraction.len() > scale as usize {
                return Err(refused());
            }
            (negative, whole.to_owned(), format!("{fraction:0<width$}", width = scale as usize))
        }
        _ => return Err(refused()),
    };
    let joined = format!("{whole}{fraction}");
    let trimmed = joined.trim_start_matches('0');
    if trimmed.is_empty() {
        return Ok((false, "0".into()));
    }
    Ok((negative, trimmed.to_owned()))
}

/// The sum of the sum cells of a statement over a column of type `ty`: its one cell, or, for the two cells of the sum of the
/// high 32 bits and the sum of the low 32 bits of an exact column on SQLite and markdown, the exact integer hi × 2^32 + lo
/// (DIA-202), an integer cell where it fits i64 and its decimal text at the scale of the column past it; null when both are
/// null, the sum of no value.
pub(crate) fn sum_cell(ty: &Type, cells: &[Val]) -> Result<Val> {
    match cells {
        [cell] => Ok(cell.clone()),
        [Val::Null, Val::Null] => Ok(Val::Null),
        [Val::I64(hi), Val::I64(lo)] if *lo >= 0 => {
            let sum = (i128::from(*hi) << 32) + i128::from(*lo);
            if let Ok(n) = i64::try_from(sum) {
                return Ok(Val::I64(n));
            }
            let scale = exact_scale(ty).ok_or_else(|| Error::internal("a split sum is over a column that is not exact"))? as usize;
            let digits = format!("{:0>width$}", sum.unsigned_abs(), width = scale + 1);
            let (whole, fraction) = digits.split_at(digits.len() - scale);
            let sign = if sum < 0 { "-" } else { "" };
            Ok(Val::Str(if scale == 0 { format!("{sign}{whole}") } else { format!("{sign}{whole}.{fraction}") }))
        }
        [_, _] => Err(refused()),
        _ => Err(Error::internal("a sum statement read no sum")),
    }
}

/// The nearest binary64 value of the digits × 10^-scale, ties to even; a value beyond the finite range is CODEC_DECODE
/// (DSL-66).
fn nearest_binary64(negative: bool, digits: &str, scale: u32) -> Result<f64> {
    let sign = if negative && digits.bytes().any(|b| b != b'0') { "-" } else { "" };
    let value = format!("{sign}{digits}e-{scale}").parse::<f64>().map_err(|error| Error::Engine {
        code: codes::CODEC_DECODE.into(),
        msg: REFUSED.into(),
        source: Some(Box::new(error)),
    })?;
    if !value.is_finite() {
        return Err(refused());
    }
    Ok(value)
}

/// The result of `get_sum` for the sum cell of a column of type `ty` (DSL-66, DSL-161).
pub(crate) fn sum_value(ty: &Type, value: &Val) -> Result<f64> {
    let Some(scale) = exact_scale(ty) else {
        return value.as_aggregate_f64();
    };
    let (negative, digits) = exact_digits(value, scale)?;
    nearest_binary64(negative, &digits, scale)
}

/// The result of `get_avg` for the sum and the count of the values of a column of type `ty`: None for no value; for an exact
/// column the exact sum divided by the count, rounded half away from zero to AVG_SCALE_EXTRA places beyond the scale of the
/// column and then converted once (DSL-66, DSL-161); for an `f64` column the binary64 sum divided by the count, which is the
/// AVG of every database.
pub(crate) fn avg_value(ty: &Type, sum: &Val, count: &Val) -> Result<Option<f64>> {
    let count = match count {
        Val::I64(n) if *n >= 0 => n.unsigned_abs(),
        _ => return Err(refused()),
    };
    if count == 0 {
        return Ok(None);
    }
    if matches!(sum, Val::Null) {
        return Err(refused());
    }
    let Some(scale) = exact_scale(ty) else {
        return Ok(Some(sum.as_aggregate_f64()? / count as f64));
    };
    let (negative, digits) = exact_digits(sum, scale)?;
    // Long division of the digits followed by one place more than the stated scale; its last digit decides the rounding
    // half away from zero. The remainder stays below the count, so ten times it fits a u128.
    let divisor = u128::from(count);
    let mut rest: u128 = 0;
    let mut quotient = Vec::with_capacity(digits.len() + AVG_SCALE_EXTRA as usize + 1);
    for digit in digits.bytes().map(|b| u128::from(b - b'0')).chain(std::iter::repeat_n(0, AVG_SCALE_EXTRA as usize + 1)) {
        let value = rest * 10 + digit;
        quotient.push(u8::try_from(value / divisor).map_err(|error| Error::internal(format!("a quotient digit exceeds 9: {error}")))?);
        rest = value % divisor;
    }
    let up = quotient.pop().is_some_and(|last| last >= 5);
    if up {
        let mut carry = true;
        for digit in quotient.iter_mut().rev() {
            if *digit == 9 {
                *digit = 0;
            } else {
                *digit += 1;
                carry = false;
                break;
            }
        }
        if carry {
            quotient.insert(0, 1);
        }
    }
    let text: String = quotient.iter().map(|d| char::from(b'0' + d)).collect();
    let text = text.trim_start_matches('0');
    nearest_binary64(negative, if text.is_empty() { "0" } else { text }, scale + AVG_SCALE_EXTRA).map(Some)
}

/// The error of a sum or average statement: PostgreSQL refuses an f64 sum beyond the finite range with SQLSTATE 22003, and
/// MySQL refuses it so through the planned addition of 0, which is the nonfinite scalar that the other databases return, so it
/// is CODEC_DECODE with the text of that scalar and the driver error as its cause (DIA-200).
pub(crate) fn range_error(error: Error) -> Error {
    let out_of_range = matches!(&error, Error::Driver { code, source, .. }
        if code == codes::DRIVER && source.as_database_error().and_then(|d| d.code()).as_deref() == Some("22003"));
    if out_of_range {
        return Error::Engine { code: codes::CODEC_DECODE.into(), msg: REFUSED.into(), source: Some(Box::new(error)) };
    }
    error
}
