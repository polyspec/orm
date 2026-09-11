//! Row sources for the generated `from_row`: a driver row decoded cell by cell straight
//! into typed fields (the main step of a plan without relation steps), or a positional
//! `Vec<Val>` row (relation steps, which are grouped by key before assembly).
//!
//! Every cell is dispatched by its column type name and decoded exactly once; a decode
//! failure is an error, never a silent NULL (F3). The typed getters coerce like `Val`'s
//! `as_*` do, so both sources yield the same field values.

use chrono::{NaiveDate, NaiveDateTime};
use sqlx::mysql::MySqlRow;
use sqlx::{Column, Row as _, TypeInfo, ValueRef as _};

use crate::value::Val;
use crate::Result;

/// What `from_row` reads its cells from. Methods take `&mut self` so the positional
/// source can move strings and decoded values out instead of cloning them.
pub trait Src {
    fn is_null(&mut self, i: usize) -> bool;
    fn i64(&mut self, i: usize) -> Result<i64>;
    fn f64(&mut self, i: usize) -> Result<f64>;
    fn bool(&mut self, i: usize) -> Result<bool>;
    fn string(&mut self, i: usize) -> Result<String>;
    fn datetime(&mut self, i: usize) -> Result<NaiveDateTime>;
    fn date(&mut self, i: usize) -> Result<NaiveDate>;
    /// A styled cell after decoding (docs/codec.md): `Val::Json`, `Val::Str`, or `Val::Null` for NULL/empty.
    fn styled(&mut self, i: usize, styles: &[String]) -> Result<Val>;
    /// A styled cell's decoded value; None for NULL/empty.
    fn json(&mut self, i: usize, styles: &[String]) -> Result<Option<serde_json::Value>> {
        Ok(self.styled(i, styles)?.take_json())
    }
    /// The cell as a `Val` (select_expr outputs, keys, parent values). A positional source
    /// clones: the same cell may still be read as a field afterwards.
    fn val(&mut self, i: usize) -> Result<Val>;
}

/// One row of a select step as handed to the generated code.
pub enum Cells {
    /// The driver row itself: decoded straight into the struct.
    Raw(MySqlRow),
    /// A positional row (styled cells already decoded).
    Pos(Vec<Val>),
}

impl Src for Cells {
    fn is_null(&mut self, i: usize) -> bool {
        match self {
            Cells::Raw(r) => raw_is_null(r, i),
            Cells::Pos(v) => v[i].is_null(),
        }
    }
    fn i64(&mut self, i: usize) -> Result<i64> {
        match self {
            Cells::Raw(r) => raw_i64(r, i),
            Cells::Pos(v) => Ok(v[i].as_i64()),
        }
    }
    fn f64(&mut self, i: usize) -> Result<f64> {
        match self {
            Cells::Raw(r) => raw_f64(r, i),
            Cells::Pos(v) => Ok(v[i].as_f64()),
        }
    }
    fn bool(&mut self, i: usize) -> Result<bool> {
        match self {
            Cells::Raw(r) => raw_bool(r, i),
            Cells::Pos(v) => Ok(v[i].as_bool()),
        }
    }
    fn string(&mut self, i: usize) -> Result<String> {
        match self {
            Cells::Raw(r) => raw_string(r, i),
            Cells::Pos(v) => Ok(v[i].take_string()),
        }
    }
    fn datetime(&mut self, i: usize) -> Result<NaiveDateTime> {
        match self {
            Cells::Raw(r) => raw_datetime(r, i),
            Cells::Pos(v) => Ok(v[i].as_datetime()),
        }
    }
    fn date(&mut self, i: usize) -> Result<NaiveDate> {
        match self {
            Cells::Raw(r) => raw_date(r, i),
            Cells::Pos(v) => Ok(v[i].as_date()),
        }
    }
    fn styled(&mut self, i: usize, styles: &[String]) -> Result<Val> {
        match self {
            Cells::Raw(r) => crate::codec::decode(styles, &read_cell(r, i)?),
            Cells::Pos(v) => Ok(std::mem::take(&mut v[i])),
        }
    }
    fn val(&mut self, i: usize) -> Result<Val> {
        match self {
            Cells::Raw(r) => read_cell(r, i),
            Cells::Pos(v) => Ok(v[i].clone()),
        }
    }
}

fn raw_is_null(r: &MySqlRow, i: usize) -> bool {
    r.try_get_raw(i).map(|v| v.is_null()).unwrap_or(true)
}

/// The cell's MySQL type name, the dispatch key of every decoder below.
fn type_name(r: &MySqlRow, i: usize) -> &str {
    r.column(i).type_info().name()
}

fn raw_i64(r: &MySqlRow, i: usize) -> Result<i64> {
    Ok(match type_name(r, i) {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => r.try_get::<Option<i64>, _>(i)?.unwrap_or(0),
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED" => r.try_get::<Option<u64>, _>(i)?.unwrap_or(0) as i64,
        "BOOLEAN" => r.try_get::<Option<bool>, _>(i)?.unwrap_or(false) as i64,
        _ => read_cell(r, i)?.as_i64(),
    })
}

fn raw_f64(r: &MySqlRow, i: usize) -> Result<f64> {
    Ok(match type_name(r, i) {
        "FLOAT" | "DOUBLE" => r.try_get::<Option<f64>, _>(i)?.unwrap_or(0.0),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => r.try_get::<Option<i64>, _>(i)?.unwrap_or(0) as f64,
        _ => read_cell(r, i)?.as_f64(),
    })
}

fn raw_bool(r: &MySqlRow, i: usize) -> Result<bool> {
    Ok(match type_name(r, i) {
        "BOOLEAN" => r.try_get::<Option<bool>, _>(i)?.unwrap_or(false),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => r.try_get::<Option<i64>, _>(i)?.unwrap_or(0) != 0,
        _ => read_cell(r, i)?.as_bool(),
    })
}

fn raw_string(r: &MySqlRow, i: usize) -> Result<String> {
    Ok(match type_name(r, i) {
        "VARCHAR" | "CHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => r.try_get::<Option<String>, _>(i)?.unwrap_or_default(),
        _ => read_cell(r, i)?.take_string(),
    })
}

fn raw_datetime(r: &MySqlRow, i: usize) -> Result<NaiveDateTime> {
    Ok(match type_name(r, i) {
        "DATETIME" => r.try_get::<Option<NaiveDateTime>, _>(i)?.unwrap_or_default(),
        "TIMESTAMP" => r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i)?.map(|t| t.naive_utc()).unwrap_or_default(),
        _ => read_cell(r, i)?.as_datetime(),
    })
}

fn raw_date(r: &MySqlRow, i: usize) -> Result<NaiveDate> {
    Ok(match type_name(r, i) {
        "DATE" => r.try_get::<Option<NaiveDate>, _>(i)?.unwrap_or_default(),
        _ => read_cell(r, i)?.as_date(),
    })
}

/// Reads one cell as a `Val` by its column type name.
pub fn read_cell(row: &MySqlRow, i: usize) -> Result<Val> {
    let v = match type_name(row, i) {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => row.try_get::<Option<i64>, _>(i)?.map(Val::I64),
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED" => row.try_get::<Option<u64>, _>(i)?.map(|x| Val::I64(x as i64)),
        "FLOAT" | "DOUBLE" => row.try_get::<Option<f64>, _>(i)?.map(Val::F64),
        // NEWDECIMAL is only compatible with a decimal type in sqlx; we surface it as f64 like Go/PHP.
        "DECIMAL" => row.try_get::<Option<rust_decimal::Decimal>, _>(i)?.map(|d| Val::F64(rust_decimal::prelude::ToPrimitive::to_f64(&d).unwrap_or(0.0))),
        // sqlx's NaiveDateTime only accepts DATETIME; TIMESTAMP columns decode as DateTime<Utc> (session tz is UTC).
        "DATETIME" => row.try_get::<Option<NaiveDateTime>, _>(i)?.map(Val::DateTime),
        "TIMESTAMP" => row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i)?.map(|t| Val::DateTime(t.naive_utc())),
        "DATE" => row.try_get::<Option<NaiveDate>, _>(i)?.map(Val::Date),
        "BOOLEAN" => row.try_get::<Option<bool>, _>(i)?.map(Val::Bool),
        // MySQL JSON columns arrive parsed; the json style then keeps the value as is.
        "JSON" => row.try_get::<Option<serde_json::Value>, _>(i)?.map(Val::Json),
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "VARBINARY" | "BINARY" => {
            // AES_DECRYPT yields BLOB; treat as text when it decodes as UTF-8 (compatibility returns strings).
            row.try_get::<Option<Vec<u8>>, _>(i)?.map(|b| match String::from_utf8(b) {
                Ok(s) => Val::Str(s),
                Err(e) => Val::Bytes(e.into_bytes()),
            })
        }
        _ => row.try_get::<Option<String>, _>(i)?.map(Val::Str),
    };
    Ok(v.unwrap_or(Val::Null))
}

/// Reads one positional row of `n` cells.
pub fn read_row(row: &MySqlRow, n: usize) -> Result<Vec<Val>> {
    (0..n).map(|i| read_cell(row, i)).collect()
}

/// Decodes styled cells (docs/codec.md) of every positional row of a step in place.
pub fn decode_styled(asm: &crate::plan::Assemble, data: &mut [Vec<Val>]) -> Result<()> {
    let styled = crate::codec::styled_cols(asm);
    if styled.is_empty() {
        return Ok(());
    }
    for row in data.iter_mut() {
        for (i, styles) in &styled {
            row[*i] = crate::codec::decode(styles, &row[*i])?;
        }
    }
    Ok(())
}
