use super::{QueryColumn, Val};

/// Typed native query values; binary is never interpreted as UTF-8 text.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum GridCell {
    Null,
    Integer(i64),
    Unsigned(u64),
    Float32(u32),
    Float64(u64),
    Decimal(String),
    Text(String),
    Boolean(bool),
    Binary(Vec<u8>),
    /// MySQL `DATE` and PostgreSQL `date`: `YYYY-MM-DD`.
    Date(String),
    /// MySQL `TIME` and PostgreSQL `time`: `HH:MM:SS` within a day, and fractional digits.
    Time(String),
    /// MySQL `DATETIME` and PostgreSQL `timestamp` without time zone: `YYYY-MM-DD HH:MM:SS` in UTC, and fractional digits.
    DateTime(String),
}
impl From<Val> for GridCell {
    fn from(value: Val) -> Self {
        match value {
            Val::Null => Self::Null,
            Val::Int(value) => Self::Integer(value),
            Val::Text(value) => Self::Text(value),
            Val::Bool(value) => Self::Boolean(value),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GridQueryResult {
    pub columns: Vec<QueryColumn>,
    pub rows: Vec<Vec<GridCell>>,
}

pub(super) fn postgres_decimal(row: &sqlx::postgres::PgRow, index: usize) -> Result<GridCell, sqlx::Error> {
    use sqlx::Row;
    let invalid = || sqlx::Error::Decode("Unsupported or invalid finite grid decimal".into());
    let Some(decimal) = row.try_get::<Option<bigdecimal::BigDecimal>, _>(index).map_err(|_| invalid())? else { return Ok(GridCell::Null) };
    let raw = row.try_get_raw(index)?;
    let decimal = if raw.format() == sqlx::postgres::PgValueFormat::Binary {
        let bytes = raw.as_bytes().map_err(|_| invalid())?;
        if bytes.len() < 8 {
            return Err(invalid());
        }
        let scale = u16::from_be_bytes([bytes[6], bytes[7]]);
        let scaled = decimal.with_scale(i64::from(scale));
        if scaled != decimal {
            return Err(invalid());
        }
        scaled
    } else {
        decimal
    };
    Ok(GridCell::Decimal(decimal.to_plain_string()))
}

use polyspec_orm::chrono::{NaiveDate, NaiveDateTime, NaiveTime, TimeDelta};

fn temporal_error(message: &str) -> sqlx::Error {
    sqlx::Error::Decode(format!("Unsupported or invalid grid temporal value: {message}").into())
}

/// `YYYY-MM-DD` within the dbspec date range 0001-01-01 to 9999-12-31.
fn date_text(date: NaiveDate) -> Result<String, sqlx::Error> {
    use polyspec_orm::chrono::Datelike;
    if !(1..=9999).contains(&date.year()) {
        return Err(temporal_error("date outside 0001-01-01 to 9999-12-31"));
    }
    Ok(date.format("%Y-%m-%d").to_string())
}

/// `HH:MM:SS.ffffff` with six fractional digits. A read of a described table is reduced to the column precision.
fn time_text(time: NaiveTime) -> String {
    time.format("%H:%M:%S%.6f").to_string()
}

fn datetime_text(value: NaiveDateTime) -> Result<String, sqlx::Error> {
    Ok(format!("{} {}", date_text(value.date())?, time_text(value.time())))
}

/// MySQL `DATE`, `TIME`, `DATETIME`. `TIMESTAMP`, which follows a time zone, does not come here.
/// `TIME` accepts only a time of day; an interval that is negative or 24 hours or more is rejected.
pub(super) fn mysql_temporal(row: &sqlx::mysql::MySqlRow, index: usize) -> Result<Option<GridCell>, sqlx::Error> {
    use sqlx::{Column, Row, TypeInfo};
    Ok(Some(match row.columns()[index].type_info().name() {
        "DATE" => match row.try_get::<Option<NaiveDate>, _>(index)? {
            Some(date) => GridCell::Date(date_text(date)?),
            None => GridCell::Null,
        },
        "TIME" => match row.try_get::<Option<sqlx::mysql::types::MySqlTime>, _>(index)? {
            Some(time) if time.is_valid_time_of_day() => {
                let value = NaiveTime::from_hms_micro_opt(time.hours(), u32::from(time.minutes()), u32::from(time.seconds()), time.microseconds())
                    .ok_or_else(|| temporal_error("time of day"))?;
                GridCell::Time(time_text(value))
            }
            Some(_) => return Err(temporal_error("time outside 00:00:00 to 23:59:59.999999")),
            None => GridCell::Null,
        },
        "DATETIME" => match row.try_get::<Option<NaiveDateTime>, _>(index)? {
            Some(value) => GridCell::DateTime(datetime_text(value)?),
            None => GridCell::Null,
        },
        _ => return Ok(None),
    }))
}

/// Binary values of PostgreSQL `date`, `time`, and `timestamp` without time zone. sqlx's chrono decoder
/// passes 24:00:00 as 00:00:00 and overflows infinity, so the value is read directly and its range checked.
pub(super) fn postgres_temporal(row: &sqlx::postgres::PgRow, index: usize) -> Result<Option<GridCell>, sqlx::Error> {
    use sqlx::{Column, Row, TypeInfo, ValueRef};
    let name = row.columns()[index].type_info().name();
    if !matches!(name, "DATE" | "TIME" | "TIMESTAMP") {
        return Ok(None);
    }
    let raw = row.try_get_raw(index)?;
    if raw.is_null() {
        return Ok(Some(GridCell::Null));
    }
    if raw.format() != sqlx::postgres::PgValueFormat::Binary {
        return Err(temporal_error("text format"));
    }
    let bytes = raw.as_bytes().map_err(|_| temporal_error("value bytes"))?;
    let epoch = NaiveDate::from_ymd_opt(2000, 1, 1).expect("2000-01-01 is a date");
    Ok(Some(match name {
        "DATE" => {
            let days = i32::from_be_bytes(bytes.try_into().map_err(|_| temporal_error("date length"))?);
            let date = epoch.checked_add_signed(TimeDelta::days(i64::from(days))).ok_or_else(|| temporal_error("infinite or out of range date"))?;
            GridCell::Date(date_text(date)?)
        }
        "TIME" => {
            let micros = i64::from_be_bytes(bytes.try_into().map_err(|_| temporal_error("time length"))?);
            if !(0..86_400_000_000).contains(&micros) {
                return Err(temporal_error("time outside 00:00:00 to 23:59:59.999999"));
            }
            GridCell::Time(time_text(NaiveTime::MIN + TimeDelta::microseconds(micros)))
        }
        _ => {
            let micros = i64::from_be_bytes(bytes.try_into().map_err(|_| temporal_error("timestamp length"))?);
            let value = epoch
                .and_time(NaiveTime::MIN)
                .checked_add_signed(TimeDelta::microseconds(micros))
                .ok_or_else(|| temporal_error("infinite or out of range timestamp"))?;
            GridCell::DateTime(datetime_text(value)?)
        }
    }))
}

/// dbspec date `YYYY-MM-DD`: a calendar date from 0001-01-01 to 9999-12-31.
pub(crate) fn is_date(text: &str) -> bool {
    use polyspec_orm::chrono::{Datelike, NaiveDate};
    text.len() == 10
        && NaiveDate::parse_from_str(text, "%Y-%m-%d").is_ok_and(|date| (1..=9999).contains(&date.year()) && date.format("%Y-%m-%d").to_string() == text)
}

/// dbspec time `HH:MM:SS` with 0 to 6 fractional digits: a time of day.
pub(crate) fn is_time(text: &str) -> bool {
    use polyspec_orm::chrono::NaiveTime;
    let (whole, digits) = text.split_once('.').map_or((text, None), |(whole, digits)| (whole, Some(digits)));
    whole.len() == 8
        && NaiveTime::parse_from_str(whole, "%H:%M:%S").is_ok_and(|time| time.format("%H:%M:%S").to_string() == whole)
        && digits.is_none_or(|digits| (1..=6).contains(&digits.len()) && digits.bytes().all(|digit| digit.is_ascii_digit()))
}

/// A date, time, or datetime value in dbspec text form. `kind` is one of date, time, datetime.
pub(crate) fn is_temporal(kind: &str, text: &str) -> bool {
    match kind {
        "date" => is_date(text),
        "time" => is_time(text),
        _ => text.split_once(' ').is_some_and(|(date, time)| is_date(date) && is_time(time)),
    }
}
