//! dbspec introspection over a sqlx connection (docs/dialects.md,
//! "Introspection"): [`introspect`] runs the fixed catalog queries of
//! `orm_schema::dbspec` on the connection and reads their rows into one dbspec
//! document and the objects it cannot express. The module also re-exports
//! every item of `orm_schema::dbspec`, so `orm::dbspec` is the one path to
//! the dbspec language.

mod apply;

pub use apply::{apply, recover, ApplyClock, ApplyConnection, ApplyError, ApplyEvent, ApplyEventError, ApplyEventKind, ApplyEvents};
pub use orm_schema::dbspec::*;
use sqlx::mysql::MySqlRow;
use sqlx::postgres::PgRow;
use sqlx::sqlite::SqliteRow;
use sqlx::{MySqlConnection, PgConnection, Row, SqliteConnection, TypeInfo, ValueRef};
use std::future::Future;

/// A connection that runs one catalog query and returns its rows as
/// [`CatalogValue`]s. The sqlx MySQL, PostgreSQL and SQLite connections
/// implement it; a pooled connection derefs to them.
pub trait CatalogQuerier {
    fn rows(&mut self, query: &'static str) -> impl Future<Output = Result<Vec<Vec<CatalogValue>>, sqlx::Error>> + Send;
}

/// The failure of [`introspect`]: a catalog query that the database rejects,
/// or catalog rows that cannot be read into a document.
#[derive(Debug)]
pub enum IntrospectError {
    Query(sqlx::Error),
    Catalog(String),
}

impl std::fmt::Display for IntrospectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IntrospectError::Query(e) => write!(f, "catalog query: {e}"),
            IntrospectError::Catalog(m) => write!(f, "catalog: {m}"),
        }
    }
}

impl std::error::Error for IntrospectError {}

/// Reads the current database (MySQL), the current schema (PostgreSQL) or the
/// `main` database (SQLite) of `connection` into the dbspec document `name`
/// and the objects it cannot read. The number of queries depends only on
/// `dialect`, which must be the database of the connection.
pub async fn introspect<Q: CatalogQuerier + ?Sized>(connection: &mut Q, dialect: Dialect, name: &str) -> Result<Introspection, IntrospectError> {
    let queries = catalog_queries(dialect);
    let mut results = Vec::with_capacity(queries.len());
    for query in queries {
        results.push(connection.rows(query).await.map_err(IntrospectError::Query)?);
    }
    read_catalog(dialect, &results, name).map_err(IntrospectError::Catalog)
}

fn decode_error(message: String) -> sqlx::Error {
    sqlx::Error::Decode(message.into())
}

/// MySQL 값의 type 이름으로 CatalogValue를 정한다. binary collation의 문자열은
/// UTF-8 text다.
fn mysql_value(row: &MySqlRow, i: usize) -> Result<CatalogValue, sqlx::Error> {
    let raw = row.try_get_raw(i)?;
    if raw.is_null() {
        return Ok(CatalogValue::Null);
    }
    let type_name = raw.type_info().name().to_owned();
    Ok(match type_name.as_str() {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => CatalogValue::Int(row.try_get(i)?),
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED" => {
            let value: u64 = row.try_get(i)?;
            CatalogValue::Int(i64::try_from(value).map_err(|e| decode_error(format!("catalog value {i}: {e}")))?)
        }
        "BOOLEAN" => CatalogValue::Bool(row.try_get(i)?),
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" => {
            let bytes: Vec<u8> = row.try_get(i)?;
            CatalogValue::Text(String::from_utf8(bytes).map_err(|e| decode_error(format!("catalog value {i}: {e}")))?)
        }
        _ => CatalogValue::Text(row.try_get(i)?),
    })
}

fn postgres_value(row: &PgRow, i: usize) -> Result<CatalogValue, sqlx::Error> {
    let raw = row.try_get_raw(i)?;
    if raw.is_null() {
        return Ok(CatalogValue::Null);
    }
    let type_name = raw.type_info().name().to_owned();
    Ok(match type_name.as_str() {
        "BOOL" => CatalogValue::Bool(row.try_get(i)?),
        "INT2" => CatalogValue::Int(i64::from(row.try_get::<i16, _>(i)?)),
        "INT4" => CatalogValue::Int(i64::from(row.try_get::<i32, _>(i)?)),
        "INT8" => CatalogValue::Int(row.try_get(i)?),
        _ => CatalogValue::Text(row.try_get(i)?),
    })
}

/// SQLite 값의 storage class로 CatalogValue를 정한다.
fn sqlite_value(row: &SqliteRow, i: usize) -> Result<CatalogValue, sqlx::Error> {
    let raw = row.try_get_raw(i)?;
    if raw.is_null() {
        return Ok(CatalogValue::Null);
    }
    let type_name = raw.type_info().name().to_owned();
    Ok(match type_name.as_str() {
        "INTEGER" => CatalogValue::Int(row.try_get(i)?),
        "TEXT" => CatalogValue::Text(row.try_get(i)?),
        other => return Err(decode_error(format!("catalog value {i} has the SQLite type {other}"))),
    })
}

impl CatalogQuerier for MySqlConnection {
    async fn rows(&mut self, query: &'static str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        let rows = sqlx::query(query).fetch_all(self).await?;
        rows.iter().map(|row| (0..row.len()).map(|i| mysql_value(row, i)).collect()).collect()
    }
}

impl CatalogQuerier for PgConnection {
    async fn rows(&mut self, query: &'static str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        let rows = sqlx::query(query).fetch_all(self).await?;
        rows.iter().map(|row| (0..row.len()).map(|i| postgres_value(row, i)).collect()).collect()
    }
}

impl CatalogQuerier for SqliteConnection {
    async fn rows(&mut self, query: &'static str) -> Result<Vec<Vec<CatalogValue>>, sqlx::Error> {
        let rows = sqlx::query(query).fetch_all(self).await?;
        rows.iter().map(|row| (0..row.len()).map(|i| sqlite_value(row, i)).collect()).collect()
    }
}
