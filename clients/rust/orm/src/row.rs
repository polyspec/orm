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
    fn i64(&mut self, i: usize) -> Result<i64>;
    fn f64(&mut self, i: usize) -> Result<f64>;
    fn bool(&mut self, i: usize) -> Result<bool>;
    fn string(&mut self, i: usize) -> Result<String>;
    fn datetime(&mut self, i: usize) -> Result<NaiveDateTime>;
    fn date(&mut self, i: usize) -> Result<NaiveDate>;
    /// A styled cell after decoding (docs/codec.md): `Val::Json`, `Val::Str`, or `Val::Null` for SQL NULL.
    fn styled(&mut self, i: usize, styles: &[String]) -> Result<Val>;
    /// A styled cell's decoded value; None for NULL/empty.
    fn json(&mut self, i: usize, styles: &[String]) -> Result<Option<serde_json::Value>> {
        self.styled(i, styles)?.take_json()
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
    fn i64(&mut self, i: usize) -> Result<i64> {
        match self {
            Cells::Raw(r) => raw_i64(r, i),
            Cells::Pos(v) => v[i].as_i64(),
        }
    }
    fn f64(&mut self, i: usize) -> Result<f64> {
        match self {
            Cells::Raw(r) => raw_f64(r, i),
            Cells::Pos(v) => v[i].as_f64(),
        }
    }
    fn bool(&mut self, i: usize) -> Result<bool> {
        match self {
            Cells::Raw(r) => raw_bool(r, i),
            Cells::Pos(v) => v[i].as_bool(),
        }
    }
    fn string(&mut self, i: usize) -> Result<String> {
        match self {
            Cells::Raw(r) => raw_string(r, i),
            Cells::Pos(v) => v[i].take_string(),
        }
    }
    fn datetime(&mut self, i: usize) -> Result<NaiveDateTime> {
        match self {
            Cells::Raw(r) => raw_datetime(r, i),
            Cells::Pos(v) => v[i].as_datetime(),
        }
    }
    fn date(&mut self, i: usize) -> Result<NaiveDate> {
        match self {
            Cells::Raw(r) => raw_date(r, i),
            Cells::Pos(v) => v[i].as_date(),
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

/// The cell's MySQL type name, the dispatch key of every decoder below.
fn type_name(r: &MySqlRow, i: usize) -> &str {
    r.column(i).type_info().name()
}

fn required_cell<T>(value: Option<T>, i: usize) -> Result<T> {
    value.ok_or_else(|| Error::Engine { code: crate::codes::CODEC_DECODE.into(), msg: format!("column {i} is NULL where a value is required") })
}

fn raw_i64(r: &MySqlRow, i: usize) -> Result<i64> {
    Ok(match type_name(r, i) {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => required_cell(r.try_get::<Option<i64>, _>(i)?, i)?,
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED" => {
            i64::try_from(required_cell(r.try_get::<Option<u64>, _>(i)?, i)?)
                .map_err(|_| Error::Engine { code: crate::codes::CODEC_DECODE.into(), msg: format!("column {i} exceeds i64 range") })?
        }
        "BOOLEAN" => i64::from(required_cell(r.try_get::<Option<bool>, _>(i)?, i)?),
        _ => read_cell_mysql(r, i)?.as_i64()?,
    })
}

fn raw_f64(r: &MySqlRow, i: usize) -> Result<f64> {
    Ok(match type_name(r, i) {
        "FLOAT" | "DOUBLE" => Val::F64(required_cell(r.try_get::<Option<f64>, _>(i)?, i)?).as_f64()?,
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => Val::I64(required_cell(r.try_get::<Option<i64>, _>(i)?, i)?).as_f64()?,
        _ => read_cell_mysql(r, i)?.as_f64()?,
    })
}

fn raw_bool(r: &MySqlRow, i: usize) -> Result<bool> {
    Ok(match type_name(r, i) {
        "BOOLEAN" => required_cell(r.try_get::<Option<bool>, _>(i)?, i)?,
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => Val::I64(required_cell(r.try_get::<Option<i64>, _>(i)?, i)?).as_bool()?,
        _ => read_cell_mysql(r, i)?.as_bool()?,
    })
}

fn raw_string(r: &MySqlRow, i: usize) -> Result<String> {
    Ok(match type_name(r, i) {
        "VARCHAR" | "CHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => required_cell(r.try_get::<Option<String>, _>(i)?, i)?,
        _ => read_cell_mysql(r, i)?.take_string()?,
    })
}

fn raw_datetime(r: &MySqlRow, i: usize) -> Result<NaiveDateTime> {
    Ok(match type_name(r, i) {
        "DATETIME" => required_cell(r.try_get::<Option<NaiveDateTime>, _>(i)?, i)?,
        "TIMESTAMP" => required_cell(r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i)?, i)?.naive_utc(),
        _ => read_cell_mysql(r, i)?.as_datetime()?,
    })
}

fn raw_date(r: &MySqlRow, i: usize) -> Result<NaiveDate> {
    Ok(match type_name(r, i) {
        "DATE" => required_cell(r.try_get::<Option<NaiveDate>, _>(i)?, i)?,
        _ => read_cell_mysql(r, i)?.as_date()?,
    })
}

/// Reads one MySQL cell as a `Val` by its column type name.
pub fn read_cell_mysql(row: &MySqlRow, i: usize) -> Result<Val> {
    let v = match type_name(row, i) {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => row.try_get::<Option<i64>, _>(i)?.map(Val::I64),
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED" => {
            return match row.try_get::<Option<u64>, _>(i)? {
                Some(value) => i64::try_from(value)
                    .map(Val::I64)
                    .map_err(|_| Error::Engine { code: crate::codes::CODEC_DECODE.into(), msg: format!("column {i} exceeds i64 range") }),
                None => Ok(Val::Null),
            };
        }
        "FLOAT" | "DOUBLE" => row.try_get::<Option<f64>, _>(i)?.map(Val::F64),
        // Preserve DECIMAL text exactly; a caller that requests f64 checks precision.
        "DECIMAL" => row.try_get::<Option<rust_decimal::Decimal>, _>(i)?.map(|d| Val::Str(d.to_string())),
        // sqlx's NaiveDateTime only accepts DATETIME; TIMESTAMP columns decode as DateTime<Utc> (session tz is UTC).
        "DATETIME" => row.try_get::<Option<NaiveDateTime>, _>(i)?.map(Val::DateTime),
        "TIMESTAMP" => row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i)?.map(|t| Val::DateTime(t.naive_utc())),
        "DATE" => row.try_get::<Option<NaiveDate>, _>(i)?.map(Val::Date),
        "BOOLEAN" => row.try_get::<Option<bool>, _>(i)?.map(Val::Bool),
        // MySQL JSON columns arrive parsed; the json style then keeps the value as is.
        "JSON" => row.try_get::<Option<serde_json::Value>, _>(i)?.map(Val::Json),
        // Authenticated AES envelopes are BLOB values; decode them as text when possible.
        "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "VARBINARY" | "BINARY" => row.try_get::<Option<Vec<u8>>, _>(i)?.map(Val::Bytes),
        _ => row.try_get::<Option<String>, _>(i)?.map(Val::Str),
    };
    Ok(v.unwrap_or(Val::Null))
}

/// Reads one PostgreSQL cell by its column type: integers of every width as i64, float and
/// numeric as exact decimal text, boolean, timestamp(tz) and date, jsonb/json parsed, bytea as bytes,
/// inet as its text (the plans select `host(col)`, so this is for raw statements).
pub fn read_cell_pg(row: &PgRow, i: usize, zone: Zone) -> Result<Val> {
    let v = match row.column(i).type_info().name() {
        "INT2" => row.try_get::<Option<i16>, _>(i)?.map(|x| Val::I64(x as i64)),
        "INT4" => row.try_get::<Option<i32>, _>(i)?.map(|x| Val::I64(x as i64)),
        "INT8" => row.try_get::<Option<i64>, _>(i)?.map(Val::I64),
        "FLOAT4" => row.try_get::<Option<f32>, _>(i)?.map(|x| Val::F64(x as f64)),
        "FLOAT8" => row.try_get::<Option<f64>, _>(i)?.map(Val::F64),
        "NUMERIC" => row.try_get::<Option<rust_decimal::Decimal>, _>(i)?.map(|d| Val::Str(d.to_string())),
        "BOOL" => row.try_get::<Option<bool>, _>(i)?.map(Val::Bool),
        "TIMESTAMP" => row.try_get::<Option<NaiveDateTime>, _>(i)?.map(Val::DateTime),
        // an instant, shown as wall-clock time in the connection zone
        "TIMESTAMPTZ" => row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(i)?.map(|t| Val::DateTime(zone.local(t))),
        "DATE" => row.try_get::<Option<NaiveDate>, _>(i)?.map(Val::Date),
        "JSONB" | "JSON" => row.try_get::<Option<serde_json::Value>, _>(i)?.map(Val::Json),
        "BYTEA" => row.try_get::<Option<Vec<u8>>, _>(i)?.map(Val::Bytes),
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
        "BLOB" => Val::Bytes(row.try_get::<Vec<u8>, _>(i)?),
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
        let version = if styled.iter().any(|c| c.host.iter().any(|style| style == "aes")) {
            let column = asm
                .aes_version
                .map(|at| &asm.columns[at])
                .ok_or_else(|| Error::Config(format!("{}: the plan reads an AES column without its key version column", asm.entity)))?;
            i32::try_from(row[column.index].as_i64()?).map_err(|_| Error::Config("AES key version is outside i32 range".into()))?
        } else {
            0
        };
        for sc in &styled {
            let mut v = std::mem::take(&mut row[sc.index]);
            if !sc.host.is_empty() {
                let key = if sc.host.iter().any(|style| style == "aes") {
                    aes_keys.get(&version).map(String::as_str).ok_or_else(|| Error::Config(format!("AES version {version} is not declared")))?
                } else {
                    // Non-AES host stages do not consume an AES key.
                    ""
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

/// Applies declared boolean column types to positional rows, including joined rows.
/// Drivers may return a boolean as an integer; an invalid value is a decode error.
pub(crate) fn decode_boolean_columns(asm: &crate::plan::Assemble, data: &mut [Vec<Val>]) -> Result<()> {
    for column in asm.columns.iter().filter(|column| column.typ == "bool") {
        for row in data.iter_mut() {
            let value = row.get_mut(column.index).ok_or_else(|| Error::internal(format!("boolean column {} has no value", column.name)))?;
            if !value.is_null() {
                *value = Val::Bool(value.as_bool()?);
            }
        }
    }
    for child in &asm.children {
        if let Some(assemble) = &child.assemble {
            decode_boolean_columns(assemble, data)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod declared_boolean_tests {
    use super::{decode_boolean_columns, Val};
    use crate::plan::{Assemble, Child, OutCol};
    use std::sync::Arc;

    #[test]
    fn selected_boolean_groups_keep_their_declared_type() {
        let _case = orm_testcase::case!(orm_testcase::DATABASE);
        let child = Assemble { columns: vec![OutCol { index: 2, name: "child_flag".into(), typ: "bool".into(), ..Default::default() }], ..Default::default() };
        let assemble = Assemble {
            columns: vec![
                OutCol { index: 0, name: "is_close".into(), typ: "bool".into(), ..Default::default() },
                OutCol { index: 1, name: "row_count".into(), typ: "i64".into(), ..Default::default() },
            ],
            children: vec![Child { assemble: Some(Arc::new(child)), ..Default::default() }],
            ..Default::default()
        };
        let mut rows = vec![vec![Val::I64(0), Val::I64(3), Val::I64(1)], vec![Val::I64(1), Val::I64(4), Val::Null]];
        decode_boolean_columns(&assemble, &mut rows).unwrap();
        assert_eq!(rows[0], vec![Val::Bool(false), Val::I64(3), Val::Bool(true)]);
        assert_eq!(rows[1], vec![Val::Bool(true), Val::I64(4), Val::Null]);
        let mut invalid = vec![vec![Val::I64(2), Val::I64(3), Val::I64(1)]];
        assert_eq!(decode_boolean_columns(&assemble, &mut invalid).unwrap_err().code(), "CODEC_DECODE");
    }
}
