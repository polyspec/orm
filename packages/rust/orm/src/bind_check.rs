//! A parameter is checked against the logical type of each slot it fills before any statement (docs/spec/protocol.md §5
//! "Parameters"): the SQL bind path reads the slot of the plan step, an IR executor the uses of `param_uses`.

use crate::db::{bound_time_value, time_value, Zone};
use crate::engine::ParamUse;
use crate::plan::BindSlot;
use crate::value::Param;
use crate::{codes, Error, Result};
use polyspec_orm_schema::dbspec::Type;

/// The logical type of a slot that a parameter fills: a dbspec type kind with the precision of a decimal, time or
/// datetime, the scale of a decimal and the length of a varchar.
pub(crate) struct ParamSlot<'a> {
    pub(crate) ty: &'a str,
    pub(crate) precision: i64,
    pub(crate) scale: i64,
    pub(crate) length: i64,
    /// The assignment of the non-null column `column`.
    pub(crate) not_null: bool,
    pub(crate) column: &'a str,
}

/// The logical type of a param bind slot of a plan step.
pub(crate) fn bind_slot_type(b: &BindSlot) -> ParamSlot<'_> {
    ParamSlot { ty: &b.col_type, precision: b.precision, scale: b.scale, length: b.length, not_null: b.not_null, column: &b.column }
}

/// The logical type of a parameter use: a use of its column's type takes the column's precision, scale and length; a
/// datetime or time of a function takes six digits.
pub(crate) fn use_slot_type<'a>(u: &'a ParamUse<'_>) -> ParamSlot<'a> {
    if let Some(f) = u.column.filter(|f| f.ty.name() == u.ty) {
        let (precision, scale, length) = match f.ty {
            Type::Decimal(p, s) => (p.into(), s.into(), 0),
            Type::Time(p) | Type::DateTime(p) => (p.into(), 0, 0),
            Type::Varchar(n) => (0, 0, n.into()),
            _ => (0, 0, 0),
        };
        return ParamSlot { ty: &u.ty, precision, scale, length, not_null: u.assign && !f.nullable, column: &f.name };
    }
    let precision = if u.ty == "datetime" || u.ty == "time" { 6 } else { 0 };
    ParamSlot { ty: &u.ty, precision, scale: 0, length: 0, not_null: false, column: "" }
}

fn encode_error(msg: String) -> Error {
    Error::Engine { code: codes::CODEC_ENCODE.into(), msg }
}

fn is_canonical_uuid(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(k, &c)| if matches!(k, 8 | 13 | 18 | 23) { c == b'-' } else { c.is_ascii_digit() || (b'a'..=b'f').contains(&c) })
}

/// Refuses SQL NULL as parameter `i` when `s` assigns a non-null column; it runs for every slot before any statement.
pub(crate) fn check_assign(i: usize, v: &Param, s: &ParamSlot<'_>) -> Result<()> {
    if matches!(v, Param::Null) && s.not_null {
        return Err(encode_error(format!("parameter {i} assigns NULL to the non-null {}", s.column)));
    }
    Ok(())
}

/// Checks the value of parameter `i` against the logical type `s` of a slot it fills: the host value kind, the range
/// of an integer, a finite f64, the precision and scale of a decimal, a date from 0001-01-01 to 9999-12-31, no
/// non-zero digit of a time or datetime past its precision, at most n characters of a varchar(n), no U+0000 in text
/// and a lower-case canonical uuid. A value outside it is CODEC_ENCODE; SQL NULL is accepted.
pub(crate) fn check_param(i: usize, v: &Param, s: &ParamSlot<'_>, zone: &Zone) -> Result<()> {
    if matches!(v, Param::Null) {
        return Ok(());
    }
    let ty = s.ty;
    let kind = || encode_error(format!("parameter {i} ({v:?}) is not a {ty} value"));
    match ty {
        "i16" | "i32" | "i64" => {
            let Param::I64(n) = *v else { return Err(kind()) };
            let (low, high) = match ty {
                "i16" => (i16::MIN.into(), i16::MAX.into()),
                "i32" => (i32::MIN.into(), i32::MAX.into()),
                _ => (i64::MIN, i64::MAX),
            };
            if n < low || n > high {
                return Err(encode_error(format!("parameter {i} ({n}) is outside {ty}")));
            }
        }
        "f64" => match *v {
            Param::F64(x) if !x.is_finite() => return Err(encode_error(format!("parameter {i} ({x}) is not a finite f64"))),
            Param::F64(_) | Param::I64(_) => {}
            _ => return Err(kind()),
        },
        "bool" => {
            if !matches!(v, Param::Bool(_)) {
                return Err(kind());
            }
        }
        "decimal" => {
            let Param::Str(text) = v else { return Err(kind()) };
            let precision = u8::try_from(s.precision).map_err(|_| encode_error(format!("invalid decimal precision {}", s.precision)))?;
            let scale = u8::try_from(s.scale).map_err(|_| encode_error(format!("invalid decimal scale {}", s.scale)))?;
            crate::decimal::normalize(text, precision, scale).map_err(|e| encode_error(format!("parameter {i}: {e}")))?;
        }
        "varchar" | "text" | "uuid" => {
            let Param::Str(text) = v else { return Err(kind()) };
            if text.contains('\0') {
                return Err(encode_error(format!("parameter {i} holds U+0000, which no {ty} value holds")));
            }
            let n = text.chars().count();
            if ty == "varchar" && s.length > 0 && i64::try_from(n).unwrap_or(i64::MAX) > s.length {
                return Err(encode_error(format!("parameter {i} has {n} characters, more than varchar({})", s.length)));
            }
            if ty == "uuid" && !is_canonical_uuid(text) {
                return Err(encode_error(format!("parameter {i} ({text:?}) is not a lower-case canonical uuid")));
            }
        }
        "bytes" => {
            if !matches!(v, Param::Bytes(_) | Param::Str(_)) {
                return Err(kind());
            }
        }
        "time" => {
            if !matches!(v, Param::Str(_)) {
                return Err(kind());
            }
            time_value(v.clone(), s.precision).map_err(|e| encode_error(format!("parameter {i}: {e}")))?;
        }
        "date" | "datetime" => {
            // Only text is a value of a date or datetime slot: a chrono value is a host value Rust refuses.
            let Param::Str(_) = v else { return Err(kind()) };
            let text = match bound_time_value(v.clone(), ty, s.precision, zone).map_err(|e| encode_error(format!("parameter {i}: {e}")))? {
                Param::Str(text) => text,
                _ => return Err(kind()),
            };
            let b = text.as_bytes();
            if b.len() < 5 || b[4] != b'-' || !b[..4].iter().all(u8::is_ascii_digit) || text.starts_with("0000") {
                return Err(encode_error(format!("parameter {i} ({v:?}) is outside 0001-01-01 to 9999-12-31")));
            }
        }
        _ => {}
    }
    Ok(())
}

/// Applies the value transform `kind` to a parameter: SQL NULL binds NULL, so `col LIKE NULL` matches no row, and a
/// value other than text is CODEC_ENCODE.
pub(crate) fn transform_param(kind: &str, v: &Param) -> Result<Param> {
    match v {
        Param::Null => Ok(Param::Null),
        Param::Str(s) => Ok(Param::Str(crate::value::transform(kind, s)?)),
        _ => Err(encode_error(format!("{kind} requires a string value"))),
    }
}

#[cfg(test)]
#[path = "../tests/unit/bind_vectors.rs"]
mod bind_vectors;
