//! Row sources for the generated `from_row`: a MySQL driver row decoded cell by cell straight
//! into typed fields (the main step of a plan without relation steps), or a positional
//! `Vec<Val>` row (relation steps, and every PostgreSQL/SQLite row, which are read
//! positionally like Go does and decoded — host stages, then codec stages — before assembly).
//!
//! Every cell is dispatched by its column type name and decoded exactly once; a decode
//! failure is an error, never a silent NULL (F3). The typed getters coerce like `Val`'s
//! `as_*` do, so both sources yield the same field values.

use chrono::{NaiveDate, NaiveDateTime};
use sqlx::mysql::MySqlRow;
use sqlx::postgres::PgRow;
use sqlx::sqlite::SqliteRow;
use sqlx::{Column, Row as _, TypeInfo, ValueRef as _};

use crate::db::Zone;
use crate::value::Val;
use crate::{Error, Result};

/// One row as the driver returned it.
pub enum DriverRow {
    MySql(MySqlRow),
    Postgres(PgRow),
    Sqlite(SqliteRow),
}

impl DriverRow {
    pub fn len(&self) -> usize {
        match self {
            DriverRow::MySql(r) => r.len(),
            DriverRow::Postgres(r) => r.len(),
            DriverRow::Sqlite(r) => r.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The driver's name of column `i` (kind raw results are keyed by it).
    pub fn column_name(&self, i: usize) -> &str {
        match self {
            DriverRow::MySql(r) => r.column(i).name(),
            DriverRow::Postgres(r) => r.column(i).name(),
            DriverRow::Sqlite(r) => r.column(i).name(),
        }
    }

    /// The MySQL row itself (the hot path keeps it undecoded until `from_row`).
    pub fn into_mysql(self) -> MySqlRow {
        match self {
            DriverRow::MySql(r) => r,
            _ => panic!("orm: a mysql pool yields mysql rows"),
        }
    }
}

/// What `from_row` reads its cells from. Methods take `&mut self` so the positional
/// source can move strings and decoded values out instead of cloning them.
pub trait Src {
    fn is_null(&mut self, i: usize) -> bool;
    fn i64(&mut self, i: usize) -> Result<i64>;
    fn f64(&mut self, i: usize) -> Result<f64>;
    fn bool(&mut self, i: usize) -> Result<bool>;
    fn string(&mut self, i: usize) -> Result<String>;
    fn point(&mut self, i: usize) -> Result<crate::Point> {
        crate::parse_point(&self.string(i)?)
    }
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
    /// The MySQL driver row itself: decoded straight into the struct when no host AES stage is
    /// present. AES rows use the positional path so the stored key version can be selected.
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
            Cells::Raw(r) => crate::codec::decode(styles, &read_cell_mysql(r, i)?),
            Cells::Pos(v) => Ok(std::mem::take(&mut v[i])),
        }
    }
    fn val(&mut self, i: usize) -> Result<Val> {
        match self {
            Cells::Raw(r) => read_cell_mysql(r, i),
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
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED" => {
            r.try_get::<Option<u64>, _>(i)?.unwrap_or(0) as i64
        }
        "BOOLEAN" => r.try_get::<Option<bool>, _>(i)?.unwrap_or(false) as i64,
        _ => read_cell_mysql(r, i)?.as_i64(),
    })
}

fn raw_f64(r: &MySqlRow, i: usize) -> Result<f64> {
    Ok(match type_name(r, i) {
        "FLOAT" | "DOUBLE" => r.try_get::<Option<f64>, _>(i)?.unwrap_or(0.0),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => r.try_get::<Option<i64>, _>(i)?.unwrap_or(0) as f64,
        _ => read_cell_mysql(r, i)?.as_f64(),
    })
}

fn raw_bool(r: &MySqlRow, i: usize) -> Result<bool> {
    Ok(match type_name(r, i) {
        "BOOLEAN" => r.try_get::<Option<bool>, _>(i)?.unwrap_or(false),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => r.try_get::<Option<i64>, _>(i)?.unwrap_or(0) != 0,
        _ => read_cell_mysql(r, i)?.as_bool(),
    })
}

fn raw_string(r: &MySqlRow, i: usize) -> Result<String> {
    Ok(match type_name(r, i) {
        "VARCHAR" | "CHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => r.try_get::<Option<String>, _>(i)?.unwrap_or_default(),
        _ => read_cell_mysql(r, i)?.take_string(),
    })
}

fn raw_datetime(r: &MySqlRow, i: usize) -> Result<NaiveDateTime> {
    Ok(match type_name(r, i) {
        "DATETIME" => r.try_get::<Option<NaiveDateTime>, _>(i)?.unwrap_or_default(),
        "TIMESTAMP" => r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i)?.map(|t| t.naive_utc()).unwrap_or_default(),
        _ => read_cell_mysql(r, i)?.as_datetime(),
    })
}

fn raw_date(r: &MySqlRow, i: usize) -> Result<NaiveDate> {
    Ok(match type_name(r, i) {
        "DATE" => r.try_get::<Option<NaiveDate>, _>(i)?.unwrap_or_default(),
        _ => read_cell_mysql(r, i)?.as_date(),
    })
}

/// Bytes as text when they are UTF-8, bytes otherwise.
fn text_or_bytes(b: Vec<u8>) -> Val {
    match String::from_utf8(b) {
        Ok(s) => Val::Str(s),
        Err(e) => Val::Bytes(e.into_bytes()),
    }
}

/// Reads one MySQL cell as a `Val` by its column type name.
pub fn read_cell_mysql(row: &MySqlRow, i: usize) -> Result<Val> {
    let v = match type_name(row, i) {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => row.try_get::<Option<i64>, _>(i)?.map(Val::I64),
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED" => {
            row.try_get::<Option<u64>, _>(i)?.map(|x| Val::I64(x as i64))
        }
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
        // Authenticated AES envelopes are BLOB values; decode them as text when possible.
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "VARBINARY" | "BINARY" => row.try_get::<Option<Vec<u8>>, _>(i)?.map(text_or_bytes),
        _ => row.try_get::<Option<String>, _>(i)?.map(Val::Str),
    };
    Ok(v.unwrap_or(Val::Null))
}

/// Reads one PostgreSQL cell by its column type: integers of every width as i64, float and
/// numeric as f64, boolean, timestamp(tz) and date, jsonb/json parsed, bytea as text-or-bytes,
/// inet as its text (the plans select `host(col)`, so this is for raw statements).
pub fn read_cell_pg(row: &PgRow, i: usize, zone: Zone) -> Result<Val> {
    let v = match row.column(i).type_info().name() {
        "INT2" => row.try_get::<Option<i16>, _>(i)?.map(|x| Val::I64(x as i64)),
        "INT4" => row.try_get::<Option<i32>, _>(i)?.map(|x| Val::I64(x as i64)),
        "INT8" => row.try_get::<Option<i64>, _>(i)?.map(Val::I64),
        "FLOAT4" => row.try_get::<Option<f32>, _>(i)?.map(|x| Val::F64(x as f64)),
        "FLOAT8" => row.try_get::<Option<f64>, _>(i)?.map(Val::F64),
        "NUMERIC" => row.try_get::<Option<rust_decimal::Decimal>, _>(i)?.map(|d| Val::F64(rust_decimal::prelude::ToPrimitive::to_f64(&d).unwrap_or(0.0))),
        "BOOL" => row.try_get::<Option<bool>, _>(i)?.map(Val::Bool),
        "TIMESTAMP" => row.try_get::<Option<NaiveDateTime>, _>(i)?.map(Val::DateTime),
        // an instant, shown as wall-clock time in the connection zone
        "TIMESTAMPTZ" => row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i)?.map(|t| Val::DateTime(zone.local(t))),
        "DATE" => row.try_get::<Option<NaiveDate>, _>(i)?.map(Val::Date),
        "JSONB" | "JSON" => row.try_get::<Option<serde_json::Value>, _>(i)?.map(Val::Json),
        "BYTEA" => row.try_get::<Option<Vec<u8>>, _>(i)?.map(text_or_bytes),
        "INET" | "CIDR" => row.try_get::<Option<sqlx::types::ipnet::IpNet>, _>(i)?.map(|n| {
            // PostgreSQL's text form: no mask on a host address
            Val::Str(if n.prefix_len() == n.max_prefix_len() { n.addr().to_string() } else { n.to_string() })
        }),
        _ => row.try_get::<Option<String>, _>(i)?.map(Val::Str),
    };
    Ok(v.unwrap_or(Val::Null))
}

/// Reads one SQLite cell by the stored value's type (SQLite is dynamically typed): INTEGER as
/// i64 (bool columns coerce in the typed getters), REAL, TEXT (datetimes stay text with six
/// fraction digits), BLOB as text-or-bytes.
pub fn read_cell_sqlite(row: &SqliteRow, i: usize) -> Result<Val> {
    let raw = row.try_get_raw(i)?;
    if raw.is_null() {
        return Ok(Val::Null);
    }
    let ty = raw.type_info();
    Ok(match ty.name() {
        "INTEGER" => Val::I64(row.try_get::<i64, _>(i)?),
        "REAL" => Val::F64(row.try_get::<f64, _>(i)?),
        "TEXT" => Val::Str(row.try_get::<String, _>(i)?),
        "BLOB" => text_or_bytes(row.try_get::<Vec<u8>, _>(i)?),
        "BOOLEAN" => Val::Bool(row.try_get::<bool, _>(i)?),
        other => return Err(crate::Error::Config(format!("sqlite column {i} holds a {other} value"))),
    })
}

/// Reads one cell as a `Val` by its column type, whichever driver produced the row.
pub fn read_cell(row: &DriverRow, i: usize, zone: Zone) -> Result<Val> {
    match row {
        DriverRow::MySql(r) => read_cell_mysql(r, i),
        DriverRow::Postgres(r) => read_cell_pg(r, i, zone),
        DriverRow::Sqlite(r) => read_cell_sqlite(r, i),
    }
}

/// Reads one positional row of `n` cells.
pub fn read_row(row: &DriverRow, n: usize, zone: Zone) -> Result<Vec<Val>> {
    (0..n).map(|i| read_cell(row, i, zone)).collect()
}

/// Decodes styled cells of every positional row of a step in place: the host stages a
/// dialect left to the executor (aes/hex/ip, with the AES secret) first, then the codec
/// stages (docs/codec.md).
pub fn decode_styled(asm: &crate::plan::Assemble, data: &mut [Vec<Val>], aes_keys: &std::collections::BTreeMap<i32, String>) -> Result<()> {
    let styled = crate::codec::styled_cols(asm);
    if styled.is_empty() {
        return Ok(());
    }
    for row in data.iter_mut() {
        let version = asm.columns.iter().find(|c| c.hidden && c.column == "aes_key_version").map(|c| row[c.index].as_i64()).unwrap_or(1) as i32;
        for sc in &styled {
            let mut v = std::mem::take(&mut row[sc.index]);
            if !sc.host.is_empty() {
                let key = if sc.host.iter().any(|style| style == "aes") {
                    aes_keys.get(&version).map(String::as_str).ok_or_else(|| Error::Config(format!("AES version {version} is not declared")))?
                } else {
                    aes_keys.values().next().map(String::as_str).unwrap_or("")
                };
                v = crate::codec::host_decode(&v, &sc.host, key)?;
            }
            if !sc.codec.is_empty() {
                v = crate::codec::decode(&sc.codec, &v)?;
            }
            row[sc.index] = v;
        }
    }
    Ok(())
}
