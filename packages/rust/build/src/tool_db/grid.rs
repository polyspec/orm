use super::value::{self, malformed, malformed_by, refuse, unsupported_driver_value};
use super::{QueryColumn, Val};
use polyspec_orm::chrono::{NaiveDate, NaiveTime, TimeDelta};

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
            Val::Unsigned(value) => Self::Unsigned(value),
            Val::Float(value) => Self::Float64(value.to_bits()),
            Val::Text(value) => Self::Text(value),
            Val::Bool(value) => Self::Boolean(value),
            Val::Binary(value) => Self::Binary(value),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GridQueryResult {
    pub columns: Vec<QueryColumn>,
    pub rows: Vec<Vec<GridCell>>,
}

/// A PostgreSQL numeric of a grid cell: its plain digits at the scale of the value, or INT-169 for NaN and the infinities.
pub(super) fn postgres_decimal(row: &sqlx::postgres::PgRow, index: usize) -> Result<GridCell, sqlx::Error> {
    use sqlx::{Row, ValueRef};
    let raw = row.try_get_raw(index)?;
    if raw.is_null() {
        return Ok(GridCell::Null);
    }
    if raw.format() != sqlx::postgres::PgValueFormat::Binary {
        return Err(unsupported_driver_value());
    }
    let text = super::pg_text::numeric(raw.as_bytes().map_err(sqlx::Error::Decode)?)?;
    if matches!(text.as_str(), "NaN" | "Infinity" | "-Infinity") {
        return Err(refuse(value::POSTGRES_NUMERIC_NOT_FINITE));
    }
    Ok(GridCell::Decimal(text))
}

/// A PostgreSQL numeric of a plain read: the text of its value, NaN and the infinities included.
pub(super) fn postgres_numeric_text(row: &sqlx::postgres::PgRow, index: usize) -> Result<Val, sqlx::Error> {
    use sqlx::{Row, ValueRef};
    let raw = row.try_get_raw(index)?;
    if raw.is_null() {
        return Ok(Val::Null);
    }
    if raw.format() != sqlx::postgres::PgValueFormat::Binary {
        return Err(unsupported_driver_value());
    }
    super::pg_text::numeric(raw.as_bytes().map_err(sqlx::Error::Decode)?).map(Val::Text)
}

/// The text cell of a PostgreSQL value whose type has a text output that no setting changes (INT-185), or None for a type of
/// another kind.
pub(super) fn postgres_text(row: &sqlx::postgres::PgRow, index: usize) -> Result<Option<Option<String>>, sqlx::Error> {
    use sqlx::{Column, Row, ValueRef};
    let Some(form) = super::pg_text::form(row.columns()[index].type_info()) else { return Ok(None) };
    let raw = row.try_get_raw(index)?;
    if raw.is_null() {
        return Ok(Some(None));
    }
    if raw.format() != sqlx::postgres::PgValueFormat::Binary {
        return Err(unsupported_driver_value());
    }
    super::pg_text::render(&form, raw.as_bytes().map_err(sqlx::Error::Decode)?).map(|text| Some(Some(text)))
}

/// Whether a PostgreSQL value of a type that has neither a text form here nor a cell kind of its own is NULL: its value is
/// refused by INT-170 and its NULL is a null cell (INT-185). False for a type of a cell kind of its own.
pub(super) fn postgres_unnamed_null(row: &sqlx::postgres::PgRow, index: usize) -> Result<bool, sqlx::Error> {
    use sqlx::{Column, Row, ValueRef};
    if super::pg_text::own_kind(row.columns()[index].type_info()) {
        return Ok(false);
    }
    if row.try_get_raw(index)?.is_null() {
        Ok(true)
    } else {
        Err(super::value::refuse(super::value::UNSUPPORTED_NATIVE_TYPE))
    }
}

/// Whether the value of a MySQL column is NULL. A zero DATE, DATETIME or TIMESTAMP is a value: sqlx-mysql's is_null treats
/// it as NULL (sqlx-mysql src/value.rs), but its bytes are the length prefix 0 of the binary protocol, while a NULL has none.
pub(super) fn mysql_value(row: &sqlx::mysql::MySqlRow, index: usize) -> Result<Option<&[u8]>, sqlx::Error> {
    use sqlx::{Row, ValueRef};
    match row.try_get_unchecked::<&[u8], _>(index) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(_) if row.try_get_raw(index)?.is_null() => Ok(None),
        Err(error) => Err(error),
    }
}

/// The date of the binary protocol of MySQL after its length prefix: INT-173 for a year outside 1 to 9999 (the zero date
/// included), and INT-174 for a month or day of no calendar date, which `ALLOW_INVALID_DATES` stores.
fn mysql_date(bytes: &[u8]) -> Result<NaiveDate, sqlx::Error> {
    let [low, high, month, day, ..] = *bytes else { return Err(refuse(value::DATE_RANGE)) };
    let year = u16::from_le_bytes([low, high]);
    if !(1..=9999).contains(&year) {
        return Err(refuse(value::DATE_RANGE));
    }
    NaiveDate::from_ymd_opt(i32::from(year), u32::from(month), u32::from(day)).ok_or_else(|| refuse(value::CALENDAR_DATE))
}

/// The value of a MySQL `DATE` or `DATETIME`: a length prefix of 0, 4, 7 or 11 bytes, the date, the time of day and the
/// microseconds (the binary protocol of MySQL).
fn mysql_datetime(bytes: &[u8], date_only: bool) -> Result<GridCell, sqlx::Error> {
    let (length, body) = bytes.split_first().ok_or_else(|| malformed("a MySQL temporal length"))?;
    if usize::from(*length) != body.len() || !matches!(length, 0 | 4 | 7 | 11) {
        return Err(malformed("a MySQL temporal length"));
    }
    if *length == 0 {
        return Err(refuse(value::DATE_RANGE));
    }
    let date = mysql_date(body)?;
    if date_only {
        if *length != 4 {
            // A driver date with a time of day (INT-171).
            return Err(unsupported_driver_value());
        }
        return Ok(GridCell::Date(date_text(date)));
    }
    let (hour, minute, second) = if *length >= 7 { (body[4], body[5], body[6]) } else { (0, 0, 0) };
    let micros = if *length == 11 { u32::from_le_bytes([body[7], body[8], body[9], body[10]]) } else { 0 };
    let time = NaiveTime::from_hms_micro_opt(u32::from(hour), u32::from(minute), u32::from(second), micros).ok_or_else(|| refuse(value::TIME_OF_DAY))?;
    Ok(GridCell::DateTime(format!("{} {}", date_text(date), time_text(time))))
}

/// `YYYY-MM-DD` of a date that is within the dbspec date range 0001-01-01 to 9999-12-31.
fn date_text(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// A date within the dbspec date range 0001-01-01 to 9999-12-31, or INT-173.
fn in_range(date: NaiveDate) -> Result<NaiveDate, sqlx::Error> {
    use polyspec_orm::chrono::Datelike;
    if (1..=9999).contains(&date.year()) {
        Ok(date)
    } else {
        Err(refuse(value::DATE_RANGE))
    }
}

/// `HH:MM:SS.ffffff` with six fractional digits. A read of a described table is reduced to the column precision.
fn time_text(time: NaiveTime) -> String {
    time.format("%H:%M:%S%.6f").to_string()
}

/// MySQL `DATE`, `TIME`, `DATETIME`. `TIMESTAMP`, which follows a time zone, does not come here.
/// `TIME` accepts only a time of day; an interval that is negative or 24 hours or more is INT-175.
pub(super) fn mysql_temporal(row: &sqlx::mysql::MySqlRow, index: usize) -> Result<Option<GridCell>, sqlx::Error> {
    use sqlx::{Column, Row, TypeInfo};
    let name = row.columns()[index].type_info().name();
    if !matches!(name, "DATE" | "DATETIME" | "TIME") {
        return Ok(None);
    }
    let Some(bytes) = mysql_value(row, index)? else { return Ok(Some(GridCell::Null)) };
    Ok(Some(match name {
        "DATE" => mysql_datetime(bytes, true)?,
        "DATETIME" => mysql_datetime(bytes, false)?,
        _ => match row.try_get::<sqlx::mysql::types::MySqlTime, _>(index)? {
            time if time.is_valid_time_of_day() => {
                let value = NaiveTime::from_hms_micro_opt(time.hours(), u32::from(time.minutes()), u32::from(time.seconds()), time.microseconds())
                    .ok_or_else(unsupported_driver_value)?;
                GridCell::Time(time_text(value))
            }
            _ => return Err(refuse(value::TIME_OF_DAY)),
        },
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
        return Err(unsupported_driver_value());
    }
    let bytes = raw.as_bytes().map_err(sqlx::Error::Decode)?;
    let epoch = NaiveDate::from_ymd_opt(2000, 1, 1).expect("2000-01-01 is a date");
    Ok(Some(match name {
        "DATE" => {
            let days = i32::from_be_bytes(bytes.try_into().map_err(|error| malformed_by("a date length", error))?);
            // infinity and -infinity are the largest and the smallest day, which are past the range too.
            let date = epoch.checked_add_signed(TimeDelta::days(i64::from(days))).ok_or_else(|| refuse(value::DATE_RANGE))?;
            GridCell::Date(date_text(in_range(date)?))
        }
        "TIME" => {
            let micros = i64::from_be_bytes(bytes.try_into().map_err(|error| malformed_by("a time length", error))?);
            if !(0..86_400_000_000).contains(&micros) {
                return Err(refuse(value::TIME_OF_DAY));
            }
            GridCell::Time(time_text(NaiveTime::MIN + TimeDelta::microseconds(micros)))
        }
        _ => {
            let micros = i64::from_be_bytes(bytes.try_into().map_err(|error| malformed_by("a timestamp length", error))?);
            let value = epoch.and_time(NaiveTime::MIN).checked_add_signed(TimeDelta::microseconds(micros)).ok_or_else(|| refuse(value::DATE_RANGE))?;
            GridCell::DateTime(format!("{} {}", date_text(in_range(value.date())?), time_text(value.time())))
        }
    }))
}

/// Whether `text` has the form of a `kind` (date, time or datetime): `YYYY-MM-DD`, `HH:MM:SS` with no fraction or one to
/// `fraction_digits` fraction digits, and the two joined by a space. The form says nothing of the range of the digits; the
/// dbspec form has at most six fraction digits.
pub fn has_temporal_form(kind: &str, text: &str, fraction_digits: usize) -> bool {
    fn digits(text: &str, pattern: &str) -> bool {
        text.len() == pattern.len() && text.bytes().zip(pattern.bytes()).all(|(byte, mark)| if mark == b'9' { byte.is_ascii_digit() } else { byte == mark })
    }
    let time = |text: &str| {
        let (whole, fraction) = text.split_once('.').map_or((text, None), |(whole, fraction)| (whole, Some(fraction)));
        digits(whole, "99:99:99")
            && fraction.is_none_or(|fraction| (1..=fraction_digits).contains(&fraction.len()) && fraction.bytes().all(|byte| byte.is_ascii_digit()))
    };
    match kind {
        "date" => digits(text, "9999-99-99"),
        "time" => time(text),
        _ => text.split_once(' ').is_some_and(|(date, rest)| digits(date, "9999-99-99") && time(rest)),
    }
}

/// The rule that a SQLite text of the dbspec form of `kind` breaks, in the order of INT-165: the date range (INT-173), the
/// calendar (INT-174) and the time of day (INT-175).
fn temporal_digits(kind: &str, text: &str) -> Result<(), value::Rule> {
    let date = |text: &str| -> Result<(), value::Rule> {
        let year: i32 = text[..4].parse().map_err(|_not_digits| value::UNSUPPORTED_DRIVER_VALUE)?;
        if !(1..=9999).contains(&year) {
            return Err(value::DATE_RANGE);
        }
        let month: u32 = text[5..7].parse().map_err(|_not_digits| value::UNSUPPORTED_DRIVER_VALUE)?;
        let day: u32 = text[8..10].parse().map_err(|_not_digits| value::UNSUPPORTED_DRIVER_VALUE)?;
        NaiveDate::from_ymd_opt(year, month, day).map(|_| ()).ok_or(value::CALENDAR_DATE)
    };
    let time = |text: &str| -> Result<(), value::Rule> {
        let part = |at: usize| text[at..at + 2].parse::<u32>().map_err(|_not_digits| value::UNSUPPORTED_DRIVER_VALUE);
        NaiveTime::from_hms_opt(part(0)?, part(3)?, part(6)?).map(|_| ()).ok_or(value::TIME_OF_DAY)
    };
    match kind {
        "date" => date(text),
        "time" => time(text),
        _ => {
            date(&text[..10])?;
            time(&text[11..])
        }
    }
}

/// The rule that the stored text of a SQLite dbspec `kind` column breaks, form first (INT-176 to INT-178), then its digits.
pub(crate) fn sqlite_temporal(kind: &str, text: &str) -> Result<(), value::Rule> {
    if !has_temporal_form(kind, text, 6) {
        return Err(match kind {
            "date" => value::SQLITE_DATE_FORM,
            "time" => value::SQLITE_TIME_FORM,
            _ => value::SQLITE_DATETIME_FORM,
        });
    }
    temporal_digits(kind, text)
}

/// A date, time, or datetime value in dbspec text form, of a calendar date from 0001-01-01 to 9999-12-31 and a time of day.
/// `kind` is one of date, time, datetime.
pub(crate) fn is_temporal(kind: &str, text: &str) -> bool {
    sqlite_temporal(kind, text).is_ok()
}
