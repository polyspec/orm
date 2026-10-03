#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamType {
    Text,
    Integer,
    Unsigned,
    Float32,
    Float64,
    Decimal,
    Boolean,
    Binary,
    Date,
    Time,
    DateTime,
}

/// Explicit native bind values. Float variants carry IEEE-754 bits.
#[derive(Clone)]
pub enum P {
    S(String),
    I(i64),
    Unsigned(u64),
    Float32(u32),
    Float64(u64),
    Decimal(String),
    Boolean(bool),
    Binary(Vec<u8>),
    /// dbspec text 형식의 date, time, datetime 값(GridCell과 같은 형식).
    Date(String),
    Time(String),
    DateTime(String),
    Null(ParamType),
}
pub(super) fn invalid() -> sqlx::Error {
    sqlx::Error::Encode("TOOL_BIND_INVALID: unsupported or invalid native bind".into())
}
pub(super) fn decimal(value: &str) -> Result<bigdecimal::BigDecimal, sqlx::Error> {
    value.parse().map_err(|_| invalid())
}
pub(super) fn validate(values: &[P], dialect: &str) -> Result<(), sqlx::Error> {
    if values.len() > 65535 {
        return Err(limit());
    }
    validate_refs(values.iter(), dialect)
}
pub(super) fn validate_refs<'a>(values: impl Iterator<Item = &'a P>, dialect: &str) -> Result<(), sqlx::Error> {
    let mut bytes = 0usize;
    for (index, value) in values.enumerate() {
        if index >= 65535 {
            return Err(limit());
        }
        let kind = match value {
            P::S(_) => ParamType::Text,
            P::I(_) => ParamType::Integer,
            P::Unsigned(_) => ParamType::Unsigned,
            P::Float32(_) => ParamType::Float32,
            P::Float64(_) => ParamType::Float64,
            P::Decimal(_) => ParamType::Decimal,
            P::Boolean(_) => ParamType::Boolean,
            P::Binary(_) => ParamType::Binary,
            P::Date(_) => ParamType::Date,
            P::Time(_) => ParamType::Time,
            P::DateTime(_) => ParamType::DateTime,
            P::Null(kind) => *kind,
        };
        if (kind == ParamType::Unsigned && dialect != "mysql") || (dialect == "sqlite" && matches!(kind, ParamType::Float32 | ParamType::Decimal)) {
            return Err(invalid());
        }
        let size = match value {
            P::S(v) | P::Decimal(v) | P::Date(v) | P::Time(v) | P::DateTime(v) => v.len(),
            P::Binary(v) => v.len(),
            P::Null(_) | P::Boolean(_) => 1,
            _ => 8,
        };
        bytes = bytes.checked_add(size).filter(|n| *n <= 16 * 1024 * 1024).ok_or_else(limit)?;
        match value {
            P::S(value) if dialect == "postgres" && value.contains('\0') => return Err(invalid()),
            // temporal 값은 dbspec text 형식이어야 한다. 다른 형식을 database 변환에 맡기지 않는다.
            P::Date(value) if !super::is_temporal("date", value) => return Err(invalid()),
            P::Time(value) if !super::is_temporal("time", value) => return Err(invalid()),
            P::DateTime(value) if !super::is_temporal("datetime", value) => return Err(invalid()),
            P::Float32(bits) if dialect == "mysql" && !f32::from_bits(*bits).is_finite() => return Err(invalid()),
            P::Float64(bits) if (dialect == "mysql" && !f64::from_bits(*bits).is_finite()) || (dialect == "sqlite" && f64::from_bits(*bits).is_nan()) => {
                return Err(invalid())
            }
            P::Decimal(value) => {
                if value.len() > 65536 {
                    return Err(limit());
                }
                let unsigned = value.strip_prefix('-').unwrap_or(value);
                let (whole, fraction) = unsigned.split_once('.').map_or((unsigned, None), |(whole, fraction)| (whole, Some(fraction)));
                if whole.is_empty()
                    || (whole.len() > 1 && whole.starts_with('0'))
                    || !whole.bytes().all(|byte| byte.is_ascii_digit())
                    || fraction.is_some_and(|fraction| fraction.is_empty() || !fraction.bytes().all(|byte| byte.is_ascii_digit()))
                {
                    return Err(invalid());
                }
            }
            _ => {}
        }
    }
    Ok(())
}
fn limit() -> sqlx::Error {
    sqlx::Error::Encode("TOOL_BIND_LIMIT: native bind budget exceeded".into())
}

#[cfg(test)]
#[path = "../../tests/unit/typed_bind_validation.rs"]
mod tests;

/// 검사된 dbspec text를 chrono 값으로 읽는다.
pub(super) fn date(value: &str) -> Result<orm::chrono::NaiveDate, sqlx::Error> {
    orm::chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| invalid())
}
pub(super) fn time(value: &str) -> Result<orm::chrono::NaiveTime, sqlx::Error> {
    orm::chrono::NaiveTime::parse_from_str(value, "%H:%M:%S%.f").map_err(|_| invalid())
}
pub(super) fn datetime(value: &str) -> Result<orm::chrono::NaiveDateTime, sqlx::Error> {
    orm::chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f").map_err(|_| invalid())
}
