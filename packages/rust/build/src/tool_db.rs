//! Database access for the tools: one reserved connection, text and integer
//! values, and statements run as written.

use sqlx::pool::PoolConnection;
use sqlx::{AssertSqlSafe, Column, Executor, MySql, Row, SqlSafeStr, Sqlite, Statement, TypeInfo, ValueRef};

use futures_util::TryStreamExt;
use polyspec_orm::db::Pool;
use polyspec_orm::markdown::{MarkdownCell, MarkdownLease};
mod binds;
mod grid;
mod limits;
mod params;
pub(crate) mod pg_describe;
mod pg_output;
pub(crate) mod pg_text;
mod result;
pub mod value;
pub use grid::{has_temporal_form, GridCell, GridQueryResult};
pub(crate) use grid::{is_temporal, sqlite_temporal};
pub use limits::QueryLimits;
pub(crate) use params::decimal_valid;
pub use params::{ParamType, P};
pub use pg_output::PgSession;
pub use result::{QueryColumn, QueryResult};

pub(crate) fn validate_params(values: &[P], dialect: &str) -> Result<(), sqlx::Error> {
    params::validate(values, dialect)
}
pub(crate) fn validate_param_refs<'a>(values: impl Iterator<Item = &'a P>, dialect: &str) -> Result<(), sqlx::Error> {
    params::validate_refs(values, dialect)
}

/// A column value as the tools read it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum Val {
    Null,
    Int(i64),
    /// A MySQL unsigned value beyond the signed 64-bit range (INT-102)
    Unsigned(u64),
    /// A float of a plain read (INT-183): a PostgreSQL real or a MySQL FLOAT widened from the float32 value that the server
    /// stores, and a double, a MySQL DOUBLE or a SQLite REAL, its non-finite values included.
    Float(f64),
    Text(String),
    Bool(bool),
    /// The bytes of a value that is not text (INT-153).
    Binary(Vec<u8>),
}

impl Val {
    pub fn text(&self) -> String {
        match self {
            Val::Null => String::new(),
            Val::Int(n) => n.to_string(),
            Val::Unsigned(n) => n.to_string(),
            Val::Float(f) => f.to_string(),
            Val::Text(s) => s.clone(),
            Val::Bool(b) => b.to_string(),
            Val::Binary(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        }
    }

    pub fn opt_text(&self) -> Option<String> {
        match self {
            Val::Null => None,
            v => Some(v.text()),
        }
    }

    pub fn int(&self) -> Result<i64, sqlx::Error> {
        match self {
            Val::Int(n) => Ok(*n),
            Val::Bool(b) => Ok(i64::from(*b)),
            Val::Text(s) => s.parse().map_err(|error| sqlx::Error::Decode(format!("Invalid tool integer: {error}").into())),
            Val::Unsigned(n) => i64::try_from(*n).map_err(|error| sqlx::Error::Decode(Box::new(error))),
            Val::Float(_) => Err(sqlx::Error::Decode("Invalid tool integer: a float".into())),
            Val::Binary(_) => Err(sqlx::Error::Decode("Invalid tool integer: binary".into())),
            Val::Null => Err(sqlx::Error::Decode("Required tool integer is NULL".into())),
        }
    }

    pub fn opt_int(&self) -> Result<Option<i64>, sqlx::Error> {
        match self {
            Val::Null => Ok(None),
            v => v.int().map(Some),
        }
    }

    pub fn bool(&self) -> Result<bool, sqlx::Error> {
        match self {
            Val::Bool(b) => Ok(*b),
            Val::Int(0) => Ok(false),
            Val::Int(1) => Ok(true),
            Val::Text(s) if matches!(s.as_str(), "t" | "true" | "1") => Ok(true),
            Val::Text(s) if matches!(s.as_str(), "f" | "false" | "0") => Ok(false),
            _ => Err(sqlx::Error::Decode("Invalid or NULL tool boolean".into())),
        }
    }
}

pub fn s(v: &str) -> P {
    P::S(v.to_owned())
}

pub type Rows = Vec<Vec<Val>>;

fn decode_bytes(value: Option<Vec<u8>>) -> Result<Val, sqlx::Error> {
    Ok(value.map_or(Val::Null, |bytes| String::from_utf8(bytes).map_or_else(|error| Val::Binary(error.into_bytes()), Val::Text)))
}

fn decode_unsigned(value: Option<u64>) -> Result<Val, sqlx::Error> {
    Ok(value.map_or(Val::Null, |value| i64::try_from(value).map_or(Val::Unsigned(value), Val::Int)))
}

macro_rules! cell_common {
    ($row:expr, $i:expr, $fallback:ident) => {{
        let (row, i) = ($row, $i);
        if let Ok(v) = row.try_get::<Option<String>, _>(i) {
            Ok(v.map_or(Val::Null, Val::Text))
        } else if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
            Ok(v.map_or(Val::Null, Val::Int))
        } else if let Ok(v) = row.try_get::<Option<i32>, _>(i) {
            Ok(v.map_or(Val::Null, |n| Val::Int(i64::from(n))))
        } else if let Ok(v) = row.try_get::<Option<i16>, _>(i) {
            Ok(v.map_or(Val::Null, |n| Val::Int(i64::from(n))))
        } else if let Ok(v) = row.try_get::<Option<bool>, _>(i) {
            Ok(v.map_or(Val::Null, Val::Bool))
        } else if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
            $crate::tool_db::decode_bytes(v)
        } else {
            $fallback!(row, i)
        }
    }};
}

macro_rules! cell {
    ($row:expr, $i:expr) => {{
        let (row, i) = ($row, $i);
        if row.columns()[i].type_info().name().ends_with(" UNSIGNED") {
            cell_extra!(row, i)
        } else {
            cell_common!(row, i, cell_extra)
        }
    }};
}

macro_rules! cell_extra {
    ($row:expr, $i:expr) => {{
        let (row, i) = ($row, $i);
        if let Ok(v) = row.try_get::<Option<u64>, _>(i) {
            $crate::tool_db::decode_unsigned(v)
        } else if let Ok(v) = row.try_get::<Option<u32>, _>(i) {
            Ok(v.map_or(Val::Null, |n| Val::Int(i64::from(n))))
        } else if let Ok(v) = row.try_get::<Option<i8>, _>(i) {
            Ok(v.map_or(Val::Null, |n| Val::Int(i64::from(n))))
        } else if let Ok(v) = row.try_get::<Option<u8>, _>(i) {
            Ok(v.map_or(Val::Null, |n| Val::Int(i64::from(n))))
        } else if let Ok(v) = row.try_get::<Option<f64>, _>(i) {
            Ok(v.map_or(Val::Null, Val::Float))
        } else {
            // A native type that has no grid cell (INT-170, INT-185).
            Err($crate::tool_db::value::refuse($crate::tool_db::value::UNSUPPORTED_NATIVE_TYPE))
        }
    }};
}

macro_rules! cell_pg_extra {
    ($row:expr, $i:expr) => {{
        let (row, i) = ($row, $i);
        if let Ok(v) = row.try_get::<Option<f32>, _>(i) {
            Ok(v.map_or(Val::Null, |n| Val::Float(f64::from(n))))
        } else if let Ok(v) = row.try_get::<Option<f64>, _>(i) {
            Ok(v.map_or(Val::Null, Val::Float))
        } else if let Ok(v) = row.try_get::<Option<i8>, _>(i) {
            Ok(v.map_or(Val::Null, |n| Val::Text((n as u8 as char).to_string())))
        } else {
            // A native type that has no grid cell (INT-170, INT-185).
            Err($crate::tool_db::value::refuse($crate::tool_db::value::UNSUPPORTED_NATIVE_TYPE))
        }
    }};
}

macro_rules! cell_pg {
    ($row:expr, $i:expr) => {
        cell_common!($row, $i, cell_pg_extra)
    };
}

macro_rules! grid_cell {
    ($row:expr, $i:expr, $decoder:ident, $($binary:literal)|+) => {{
        let (row, i) = ($row, $i);
        let raw = row.try_get_raw(i)?;
        if raw.is_null() { Ok(GridCell::Null) }
        else if matches!(raw.type_info().name(), "FLOAT"|"FLOAT4") {
            row.try_get::<f32, _>(i).map(|value| GridCell::Float32(value.to_bits()))
        }
        else if matches!(raw.type_info().name(), "DOUBLE"|"FLOAT8"|"REAL") {
            row.try_get::<f64, _>(i).map(|value| GridCell::Float64(value.to_bits()))
        }
        else if matches!(raw.type_info().name(), $($binary)|+) {
            row.try_get::<Vec<u8>, _>(i).map(GridCell::Binary)
        } else { $decoder!(row, i).map(GridCell::from) }
    }};
}
macro_rules! grid_mysql {
    ($row:expr, $i:expr) => {{
        let (row, i) = ($row, $i);
        match row.columns()[i].type_info().name() {
            // A YEAR() result is a MySQL YEAR field, which has no grid cell (INT-166), and a TIMESTAMP follows the time zone of
            // the session (INT-167); a NULL of either is a null cell.
            "YEAR" => grid::mysql_value(row, i).and_then(|value| value.map_or(Ok(GridCell::Null), |_| Err(value::refuse(value::MYSQL_YEAR)))),
            "TIMESTAMP" => grid::mysql_value(row, i).and_then(|value| value.map_or(Ok(GridCell::Null), |_| Err(value::refuse(value::MYSQL_TIMESTAMP)))),
            "DECIMAL" => row
                .try_get::<Option<bigdecimal::BigDecimal>, _>(i)
                .map(|value| value.map_or(GridCell::Null, |value| GridCell::Decimal(value.to_plain_string()))),
            "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" | "BIGINT UNSIGNED" => {
                row.try_get::<Option<u64>, _>(i).map(|value| value.map_or(GridCell::Null, GridCell::Unsigned))
            }
            _ => {
                if let Some(cell) = grid::mysql_temporal(row, i)? {
                    Ok(cell)
                } else if let Some(cell) = mysql_native(row, i)? {
                    Ok(GridCell::from(cell))
                } else if <String as sqlx::Type<MySql>>::compatible(row.columns()[i].type_info()) {
                    // A string column of `_bin` collation gets the VARBINARY name because of the BINARY flag,
                    // but since its collation is not binary, it is text.
                    row.try_get::<Option<String>, _>(i).map(|value| value.map_or(GridCell::Null, GridCell::Text))
                } else {
                    grid_cell!(row, i, cell, "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB")
                }
            }
        }
    }};
}
macro_rules! grid_pg {
    ($row:expr, $i:expr) => {{
        let (row, i) = ($row, $i);
        match row.columns()[i].type_info().name() {
            "NUMERIC" => grid::postgres_decimal(row, i),
            // A timestamptz and a timetz follow the TimeZone of the session (INT-168); a NULL of either is a null cell.
            "TIMESTAMPTZ" | "TIMETZ" => {
                if row.try_get_raw(i)?.is_null() {
                    Ok(GridCell::Null)
                } else {
                    Err(value::refuse(value::POSTGRES_ZONED))
                }
            }
            _ => {
                if let Some(cell) = grid::postgres_temporal(row, i)? {
                    Ok(cell)
                } else if let Some(text) = grid::postgres_text(row, i)? {
                    Ok(text.map_or(GridCell::Null, GridCell::Text))
                } else if grid::postgres_unnamed_null(row, i)? {
                    Ok(GridCell::Null)
                } else {
                    grid_cell!(row, i, cell_pg, "BYTEA")
                }
            }
        }
    }};
}
macro_rules! grid_sqlite {
    ($row:expr, $i:expr) => {
        grid_cell!($row, $i, cell, "BLOB")
    };
}

/// The plain value of a temporal grid cell: its text (INT-153).
pub(crate) fn temporal_val(cell: GridCell) -> Result<Val, sqlx::Error> {
    match cell {
        GridCell::Null => Ok(Val::Null),
        GridCell::Date(text) | GridCell::Time(text) | GridCell::DateTime(text) => Ok(Val::Text(text)),
        // A conversion of a value of another kind is no temporal value of the driver (INT-171).
        _ => Err(value::unsupported_driver_value()),
    }
}

/// The MySQL types whose cell is the text or the bytes that the server writes (INT-185): `JSON`, in its normalized `utf8mb4`
/// form, and `BIT` and the spatial types, which the server returns as a binary string.
fn mysql_native(row: &sqlx::mysql::MySqlRow, i: usize) -> Result<Option<Val>, sqlx::Error> {
    let name = row.columns()[i].type_info().name();
    if !matches!(name, "JSON" | "BIT" | "GEOMETRY") {
        return Ok(None);
    }
    let Some(bytes) = grid::mysql_value(row, i)? else { return Ok(Some(Val::Null)) };
    Ok(Some(if name == "JSON" {
        Val::Text(String::from_utf8(bytes.to_vec()).map_err(|error| sqlx::Error::Decode(Box::new(error)))?)
    } else {
        Val::Binary(bytes.to_vec())
    }))
}

/// A plain value of a MySQL read query: a date, time or datetime is the text of its grid cell (INT-153), and a decimal its
/// plain digits.
macro_rules! query_cell {
    ($row:expr, $i:expr) => {{
        let (row, i) = ($row, $i);
        if let Some(temporal) = grid::mysql_temporal(row, i)? {
            $crate::tool_db::temporal_val(temporal)
        } else if let Some(value) = mysql_native(row, i)? {
            Ok(value)
        } else if row.columns()[i].type_info().name() == "DECIMAL" {
            row.try_get::<Option<bigdecimal::BigDecimal>, _>(i).map(|value| value.map_or(Val::Null, |value| Val::Text(value.to_plain_string())))
        } else {
            cell!(row, i)
        }
    }};
}

/// A plain value of a PostgreSQL read query: a date, time or timestamp is the text of its grid cell (INT-153), a numeric its
/// text, and a type of a text output that no setting changes that text (INT-185).
macro_rules! query_cell_pg {
    ($row:expr, $i:expr) => {{
        let (row, i) = ($row, $i);
        if let Some(temporal) = grid::postgres_temporal(row, i)? {
            $crate::tool_db::temporal_val(temporal)
        } else if row.columns()[i].type_info().name() == "NUMERIC" {
            grid::postgres_numeric_text(row, i)
        } else if let Some(text) = grid::postgres_text(row, i)? {
            Ok(text.map_or(Val::Null, Val::Text))
        } else if grid::postgres_unnamed_null(row, i)? {
            Ok(Val::Null)
        } else {
            cell_pg!(row, i)
        }
    }};
}

/// Checks the budget of one fetched row, converts its cells and keeps them in `rows`.
macro_rules! push_row {
    ($row:ident, $budget:expr, $rows:ident, $cell:ident) => {
        push_row!($row, $budget, $rows, $cell, $row.columns().len())
    };
    ($row:ident, $budget:expr, $rows:ident, $cell:ident, $width:expr) => {
        $budget.check_row_count($rows.len())?;
        // A conversion that fails names the position of its column, and a failure of the driver is kept as its cause (INT-165,
        // INT-172).
        let convert = |i: usize| -> Result<_, sqlx::Error> { $cell!(&$row, i) };
        let values = (0..$width).map(|i| convert(i).map_err(|error| value::at_column(error, i))).collect::<Result<Vec<_>, sqlx::Error>>()?;
        $budget.add_row(&values, $rows.len())?;
        $rows.push(values);
    };
}

macro_rules! fetch_result {
    ($conn:expr, $sql:expr, $params:expr, $budget:expr, $cell:ident, $result:ident, $bind:ident) => {{
        let statement_length = $sql.0.len();
        let statement = prepare_query!($conn, $sql, $params, $bind);
        let columns = result::columns(statement_length, statement.columns().iter().map(|column| (column.name(), column.type_info().name())))?;
        let q = binds::$bind(statement.query(), $params)?;
        let mut stream = q.fetch(&mut **$conn);
        let mut rows = Vec::new();
        while let Some(row) = stream.try_next().await? {
            push_row!(row, $budget, rows, $cell);
        }
        Ok($result { columns, rows })
    }};
}

/// Reads the rows of a PostgreSQL `stream` into `rows`, the output settings of each row checked against the baseline of a
/// catalog session before the row is converted (INT-186); evaluates to the number of rows read.
macro_rules! push_pg_rows {
    ($stream:expr, $baseline:expr, $width:expr, $budget:expr, $rows:ident, $cell:ident) => {{
        let mut stream = $stream;
        let mut read = 0usize;
        while let Some(row) = stream.try_next().await? {
            if let Some(baseline) = $baseline {
                pg_output::check_row(&row, $width, baseline)?;
            }
            push_row!(row, $budget, $rows, $cell, $width);
            read += 1;
        }
        read
    }};
}

/// The result of a statement on a PostgreSQL session. In a catalog session the statement runs in the CTE that carries the output
/// settings of each row, which are checked before the row is converted and are no columns of the result, and the settings are
/// checked once more after the rows (INT-186).
macro_rules! fetch_pg_result {
    ($conn:expr, $sql:expr, $params:expr, $budget:expr, $cell:ident, $result:ident) => {{
        let connection = $conn;
        let statement_length = $sql.0.len();
        let baseline = connection.baseline();
        let (sql, carried) = match &baseline {
            Some(_) => (AssertSqlSafe(pg_output::carrying(&$sql.0)), pg_output::SETTING_COUNT),
            None => ($sql, 0),
        };
        let statement = prepare_query!(connection, sql, $params, postgres);
        let width = statement.columns().len().saturating_sub(carried);
        let columns = result::columns(statement_length, statement.columns()[..width].iter().map(|column| (column.name(), column.type_info().name())))?;
        let q = binds::postgres(statement.query(), $params)?;
        let mut rows = Vec::new();
        push_pg_rows!(q.fetch(&mut **connection), &baseline, width, $budget, rows, $cell);
        if let Some(baseline) = &baseline {
            pg_output::check_after(&mut **connection, baseline).await?;
        }
        Ok($result { columns, rows })
    }};
}

/// The result of a statement on a markdown connection: its columns and rows, each cell read as the SQLite connection reads it, under
/// the same budget.
macro_rules! markdown_result {
    ($conn:expr, $sql:expr, $params:expr, $budget:expr, $cell:ident, $result:ident) => {{
        let text: String = $sql.0;
        let wire = binds::markdown($params)?;
        let mut rows = Vec::new();
        // The budget reads the rows as they arrive: a row past it stops the statement on the server (CFG-35).
        let head = $conn
            .statement_rows(&text, &wire, |row| {
                $budget.check_row_count(rows.len())?;
                let values = row
                    .into_iter()
                    .enumerate()
                    .map(|(i, cell)| $cell(cell).map_err(|error| value::at_column(error, i)))
                    .collect::<Result<Vec<_>, sqlx::Error>>()?;
                $budget.add_row(&values, rows.len())?;
                rows.push(values);
                Ok(())
            })
            .await?;
        let columns = result::columns(text.len(), head.columns.iter().map(|column| (column.name.as_str(), markdown_native_type(&column.declared))))?;
        Ok($result { columns, rows })
    }};
}

/// The native type of a column of a markdown statement: its declared type, or NULL for an expression, as the SQLite driver names it.
fn markdown_native_type(declared: &str) -> &str {
    if declared.is_empty() {
        "NULL"
    } else {
        declared
    }
}

/// A plain value of a markdown statement, read as `cell!` reads a SQLite value.
fn markdown_cell(cell: MarkdownCell) -> Result<Val, sqlx::Error> {
    match cell {
        MarkdownCell::Null => Ok(Val::Null),
        MarkdownCell::Integer(n) => Ok(Val::Int(n)),
        MarkdownCell::Text(text) => Ok(Val::Text(text)),
        MarkdownCell::TextBytes(bytes) | MarkdownCell::Blob(bytes) => decode_bytes(Some(bytes)),
        MarkdownCell::Real(value) => Ok(Val::Float(value)),
    }
}

/// A grid cell of a markdown statement, read as `grid_sqlite!` reads a SQLite value.
fn markdown_grid_cell(cell: MarkdownCell) -> Result<GridCell, sqlx::Error> {
    match cell {
        MarkdownCell::Real(value) => Ok(GridCell::Float64(value.to_bits())),
        MarkdownCell::Blob(bytes) => Ok(GridCell::Binary(bytes)),
        other => markdown_cell(other).map(GridCell::from),
    }
}

/// The rows that a PostgreSQL cursor fetches in one round trip.
const PG_CURSOR_CHUNK: usize = 256;

/// The sequence of the cursors that a read opens, so that each read names its cursor.
static CURSOR_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The rows of a PostgreSQL read with no parameter, streamed through a cursor in chunks of PG_CURSOR_CHUNK rows. A budget
/// stop ends the read after the chunk it stopped in, and the transaction that the read runs in closes the cursor.
macro_rules! fetch_cursor_result {
    ($conn:expr, $sql:expr, $budget:expr, $cell:ident, $result:ident) => {{
        let (connection, text) = ($conn, $sql.0);
        let statement_length = text.len();
        // In a catalog session the statement carries the output settings of each row (INT-186).
        let baseline = connection.baseline();
        let (text, carried) = match &baseline {
            Some(_) => (pg_output::carrying(&text), pg_output::SETTING_COUNT),
            None => (text, 0),
        };
        let statement = match (&mut **connection).prepare(AssertSqlSafe(text.clone()).into_sql_str()).await {
            Ok(statement) => statement,
            Err(error) => return Err(pg_describe::refusal(&mut **connection, &text, &[], error).await),
        };
        let width = statement.columns().len().saturating_sub(carried);
        let columns = result::columns(statement_length, statement.columns()[..width].iter().map(|column| (column.name(), column.type_info().name())))?;
        let cursor = format!("orm_read_{}", CURSOR_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        sqlx::query(AssertSqlSafe(format!("DECLARE {cursor} NO SCROLL CURSOR FOR {text}"))).execute(&mut **connection).await?;
        let mut rows = Vec::new();
        loop {
            let chunk = sqlx::query(AssertSqlSafe(format!("FETCH FORWARD {PG_CURSOR_CHUNK} FROM {cursor}"))).fetch(&mut **connection);
            let fetched = push_pg_rows!(chunk, &baseline, width, $budget, rows, $cell);
            if fetched < PG_CURSOR_CHUNK {
                break;
            }
        }
        sqlx::query(AssertSqlSafe(format!("CLOSE {cursor}"))).execute(&mut **connection).await?;
        if let Some(baseline) = &baseline {
            pg_output::check_after(&mut **connection, baseline).await?;
        }
        Ok($result { columns, rows })
    }};
}

/// The plain result of a checked statement on the connection of each dialect, its MySQL and PostgreSQL values read by the cells
/// that the caller names: `cell` and `cell_pg` for a statement, `query_cell` and `query_cell_pg` for a read query, whose temporal
/// values are grid text (INT-153).
macro_rules! plain_result_of {
    ($conn:expr, $sql:ident, $params:ident, $budget:ident, $mysql_cell:ident, $pg_cell:ident) => {
        match $conn {
            Conn::MySql(c) => fetch_result!(c, $sql, $params, $budget, $mysql_cell, QueryResult, mysql),
            Conn::Postgres(c) => fetch_pg_result!(c, $sql, $params, $budget, $pg_cell, QueryResult),
            Conn::Sqlite(c) => fetch_result!(c, $sql, $params, $budget, cell, QueryResult, sqlite),
            Conn::Markdown(c) => markdown_result!(c, $sql, $params, $budget, markdown_cell, QueryResult),
        }
    };
}

/// The typed grid result of a checked statement on the connection of each dialect.
macro_rules! grid_result_of {
    ($conn:expr, $sql:ident, $params:ident, $budget:ident) => {
        match $conn {
            Conn::MySql(c) => fetch_result!(c, $sql, $params, $budget, grid_mysql, GridQueryResult, mysql),
            Conn::Postgres(c) => fetch_pg_result!(c, $sql, $params, $budget, grid_pg, GridQueryResult),
            Conn::Sqlite(c) => fetch_result!(c, $sql, $params, $budget, grid_sqlite, GridQueryResult, sqlite),
            Conn::Markdown(c) => markdown_result!(c, $sql, $params, $budget, markdown_grid_cell, GridQueryResult),
        }
    };
}

macro_rules! prepare_query {
    ($conn:expr,$sql:expr,$params:expr,postgres) => {{
        let types = binds::postgres_types($params)?;
        let text = $sql.0.clone();
        match (&mut **$conn).prepare_with($sql.into_sql_str(), &types).await {
            Ok(statement) => statement,
            Err(error) => return Err(pg_describe::refusal(&mut **$conn, &text, &types, error).await),
        }
    }};
    ($conn:expr,$sql:expr,$params:expr,mysql) => {
        (&mut **$conn).prepare($sql.into_sql_str()).await?
    };
    ($conn:expr,$sql:expr,$params:expr,sqlite) => {
        (&mut **$conn).prepare($sql.into_sql_str()).await?
    };
}

/// One reserved connection of a pool.
pub enum Conn {
    MySql(PoolConnection<MySql>),
    /// A reserved PostgreSQL connection with the output settings of its catalog session (INT-186).
    Postgres(PgSession),
    Sqlite(PoolConnection<Sqlite>),
    /// A session of a markdown connection, whose server runs SQL in SQLite's dialect (DIA-185).
    Markdown(MarkdownLease),
}

fn has_params(params: &[P]) -> bool {
    !params.is_empty()
}

impl Conn {
    /// Statement-scoped MySQL identity, not session-global state or a guessed key.
    pub(crate) async fn mysql_insert(&mut self, sql: &str, params: &[P]) -> Result<(u64, u64), sqlx::Error> {
        self.validate_params(params)?;
        let Conn::MySql(connection) = self else {
            return Err(sqlx::Error::Decode("TOOL_INSERT_DIALECT: expected MySQL".into()));
        };
        let sql = AssertSqlSafe(sql.to_owned());
        let result = binds::mysql(sqlx::query(sql), params)?.execute(&mut **connection).await?;
        Ok((result.rows_affected(), result.last_insert_id()))
    }
    fn validate_params(&self, values: &[P]) -> Result<(), sqlx::Error> {
        params::validate(
            values,
            match self {
                Self::MySql(_) => "mysql",
                Self::Postgres(_) => "postgres",
                Self::Sqlite(_) | Self::Markdown(_) => "sqlite",
            },
        )
    }
    /// Never return a scope-modified connection to the pool, including cancellation.
    pub(crate) fn discard_on_drop(&mut self) {
        match self {
            Self::MySql(c) => c.close_on_drop(),
            Self::Postgres(c) => c.pooled().close_on_drop(),
            Self::Sqlite(c) => c.close_on_drop(),
            Self::Markdown(c) => c.discard(),
        }
    }
    /// Gives a connection that `discard_on_drop` marked back to its pool, which holds it for the next session: only a session that
    /// ended cleanly calls this. The caller waits for it, so the next acquire finds the connection idle and opens no other.
    pub(crate) async fn return_to_pool(mut self) {
        match &mut self {
            Self::MySql(c) => c.return_to_pool().await,
            Self::Postgres(c) => c.pooled().return_to_pool().await,
            Self::Sqlite(c) => c.return_to_pool().await,
            Self::Markdown(c) => c.keep(),
        }
    }
    /// Fixes the output settings of the PostgreSQL transaction that has just begun and reads the seven that a catalog read
    /// compares (INT-186); other connections have none.
    pub(crate) async fn fix_output_settings(&mut self) -> Result<(), sqlx::Error> {
        match self {
            Self::Postgres(c) => c.fix_output().await,
            _ => Ok(()),
        }
    }
    /// Forgets the named statements of a PostgreSQL connection, on the server and in its statement cache.
    pub(crate) async fn forget_statements(&mut self) -> Result<(), sqlx::Error> {
        match self {
            Self::Postgres(c) => sqlx::Connection::clear_cached_statements(&mut **c).await,
            _ => Ok(()),
        }
    }
    /// Closes the socket on the spot, so the server ends what the connection still runs. A pool closes a discarded connection through a
    /// flush, which reads the rest of an unread result first, and through ProxySQL waits on a read that it paused (CFG-34).
    pub(crate) fn close_now(self) {
        match self {
            Self::MySql(c) => drop(c.detach()),
            Self::Postgres(c) => drop(c.into_pooled().detach()),
            Self::Sqlite(c) => drop(c.detach()),
            Self::Markdown(mut c) => c.discard(),
        }
    }
    pub async fn acquire(pool: &Pool) -> Result<Conn, sqlx::Error> {
        Ok(match pool {
            Pool::MySql(p) => Conn::MySql(p.acquire().await?),
            Pool::Postgres(p) => Conn::Postgres(PgSession::new(p.acquire().await?)),
            Pool::Sqlite(p) => Conn::Sqlite(p.acquire().await?),
            Pool::Markdown(p) => Conn::Markdown(p.acquire().await?),
        })
    }

    /// Rolls the transaction back. A SQLite transaction that SQLite already
    /// rolled back by itself, after `RAISE(ROLLBACK)` or an I/O error, is not
    /// rolled back again: that ROLLBACK would fail (INT-155). A markdown session
    /// reports no autocommit state, so its ROLLBACK is always sent.
    pub async fn rollback(&mut self) -> Result<(), sqlx::Error> {
        if let Conn::Sqlite(c) = self {
            if !polyspec_orm::db::sqlite_in_transaction(c).await? {
                return Ok(());
            }
        }
        self.exec("ROLLBACK", &[]).await.map(|_| ())
    }

    /// Runs a statement and returns the affected rows. A statement without
    /// binds is sent as written.
    pub async fn exec(&mut self, sql: &str, params: &[P]) -> Result<u64, sqlx::Error> {
        self.validate_params(params)?;
        let sql = AssertSqlSafe(sql.to_owned());
        macro_rules! run {
            ($conn:expr,$bind:ident) => {{
                if has_params(params) {
                    let q = binds::$bind(sqlx::query(sql), params)?;
                    q.execute(&mut **$conn).await?.rows_affected()
                } else {
                    sqlx::raw_sql(sql).execute(&mut **$conn).await?.rows_affected()
                }
            }};
        }
        Ok(match self {
            Conn::MySql(c) => run!(c, mysql),
            Conn::Postgres(c) => run!(c, postgres),
            Conn::Sqlite(c) => run!(c, sqlite),
            Conn::Markdown(c) => c.statement(&sql.0, &binds::markdown(params)?).await?.affected,
        })
    }

    /// Runs a query and returns its rows.
    pub async fn query(&mut self, sql: &str, params: &[P]) -> Result<Rows, sqlx::Error> {
        self.query_bounded(sql, params, QueryLimits::default()).await
    }

    /// Rejects oversized accumulated results; never returns truncated rows.
    pub async fn query_bounded(&mut self, sql: &str, params: &[P], limits: QueryLimits) -> Result<Rows, sqlx::Error> {
        Ok(self.query_result_bounded(sql, params, limits).await?.rows)
    }

    fn bounded_query(&self, sql: &str, params: &[P], limits: QueryLimits) -> Result<(AssertSqlSafe<String>, limits::Budget), sqlx::Error> {
        self.single_statement(sql, params, || limits::Budget::new(limits))
    }

    /// The one statement of `sql` with its parameters checked, and the budget that `budget` makes after that check.
    fn single_statement<B>(&self, sql: &str, params: &[P], budget: impl FnOnce() -> Result<B, sqlx::Error>) -> Result<(AssertSqlSafe<String>, B), sqlx::Error> {
        self.validate_params(params)?;
        let budget = budget()?;
        if polyspec_orm_schema::sql::split_sql(sql).len() != 1 {
            return Err(sqlx::Error::Decode("TOOL_QUERY_STATEMENT: expected one statement".into()));
        }
        Ok((AssertSqlSafe(sql.to_owned()), budget))
    }

    /// Ordered prepared columns and bounded checked rows, including empty results.
    pub async fn query_result_bounded(&mut self, sql: &str, params: &[P], limits: QueryLimits) -> Result<QueryResult, sqlx::Error> {
        let (sql, mut budget) = self.bounded_query(sql, params, limits)?;
        plain_result_of!(self, sql, params, budget, cell, cell_pg)
    }

    /// Reads converted plain values under the client-visible cell-byte budget used by catalogs. A PostgreSQL read with no
    /// parameter streams its rows through a cursor, so that a budget stop does not wait for the whole statement.
    pub(crate) async fn query_result_values_bounded(&mut self, sql: &str, params: &[P], limits: QueryLimits) -> Result<QueryResult, sqlx::Error> {
        let (sql, mut budget) = self.single_statement(sql, params, || limits::ValueBudget::new(limits))?;
        match self {
            Conn::Postgres(c) if !has_params(params) => fetch_cursor_result!(c, sql, budget, query_cell_pg, QueryResult),
            _ => plain_result_of!(self, sql, params, budget, query_cell, query_cell_pg),
        }
    }

    /// Typed SQL grid rows using the same streaming and metadata budgets.
    pub async fn grid_query_bounded(&mut self, sql: &str, params: &[P], limits: QueryLimits) -> Result<GridQueryResult, sqlx::Error> {
        let (sql, mut budget) = self.bounded_query(sql, params, limits)?;
        grid_result_of!(self, sql, params, budget)
    }

    /// Reads converted grid cells under the client-visible cell-byte budget used by catalogs. A PostgreSQL read with no
    /// parameter streams its rows through a cursor, so that a budget stop does not wait for the whole statement.
    pub(crate) async fn grid_query_values_bounded(&mut self, sql: &str, params: &[P], limits: QueryLimits) -> Result<GridQueryResult, sqlx::Error> {
        let (sql, mut budget) = self.single_statement(sql, params, || limits::ValueBudget::new(limits))?;
        match self {
            Conn::Postgres(c) if !has_params(params) => fetch_cursor_result!(c, sql, budget, grid_pg, GridQueryResult),
            _ => grid_result_of!(self, sql, params, budget),
        }
    }
}

/// The bind placeholder of a driver.
pub fn placeholder(driver: &str, n: usize) -> String {
    if driver == "postgres" {
        format!("${n}")
    } else {
        "?".into()
    }
}

/// A database named by the same DSN URI the clients accept: `mysql://`,
/// `postgres://`, or `sqlite://<absolute path>`. The scheme selects the
/// dialect.
pub struct ToolDsn {
    pub dialect: String,
    url: url::Url,
}

impl ToolDsn {
    /// Parses a DSN URI.
    pub fn parse(raw: &str) -> Result<ToolDsn, String> {
        let url = url::Url::parse(raw).map_err(|error| format!("MIGRATION_CONFIG: dsn must be a URI using mysql://, postgres://, or sqlite://: {error}"))?;
        let dialect = url.scheme().to_lowercase();
        let host = url.host_str().unwrap_or("");
        let database = url.path().trim_matches('/');
        match dialect.as_str() {
            "mysql" if host.is_empty() || database.is_empty() => return Err("MIGRATION_CONFIG: mysql DSN must include host and database".into()),
            "postgres" if (host.is_empty() && !url.query_pairs().any(|(k, _)| k == "host")) || database.is_empty() => {
                return Err("MIGRATION_CONFIG: postgres DSN must include host and database".into());
            }
            "sqlite" if !url.path().starts_with('/') || !host.is_empty() => return Err("MIGRATION_CONFIG: sqlite DSN must be sqlite://<absolute path>".into()),
            "mysql" | "postgres" | "sqlite" => {}
            // A URL scheme has only ASCII letters, digits, `+`, `-`, `.`, so it is only wrapped in quotes.
            _ => return Err(format!("MIGRATION_CONFIG: unsupported DSN scheme \"{dialect}\"; want mysql, postgres, or sqlite")),
        }
        Ok(ToolDsn { dialect, url })
    }

    /// The DSN with its password hidden.
    pub fn redacted(&self) -> Result<String, String> {
        let mut url = self.url.clone();
        if url.password().is_some() {
            url.set_password(Some("xxxxx")).map_err(|()| "the password of the DSN cannot be hidden".to_owned())?;
        }
        Ok(url.to_string())
    }
}

/// Opens the database of a DSN URI and reserves a connection.
pub async fn open(raw: &str) -> Result<(polyspec_orm::Db, Conn, ToolDsn), String> {
    let dsn = ToolDsn::parse(raw)?;
    // The tools check SQLite foreign keys with foreign_key_check instead of
    // enforcing them, so a table rebuild does not fire ON DELETE actions.
    let target = if dsn.dialect == "sqlite" && !raw.contains("foreign_keys") {
        format!("{raw}{}_pragma=foreign_keys(0)", if raw.contains('?') { '&' } else { '?' })
    } else {
        raw.to_owned()
    };
    let connect_err = |e: &dyn std::fmt::Display| match dsn.redacted() {
        Ok(text) => format!("MIGRATION_CONNECT: dsn={text}: {e}"),
        Err(reason) => format!("MIGRATION_CONNECT: dsn could not be shown ({reason}): {e}"),
    };
    let db = polyspec_orm::Db::connect(&target, 4, polyspec_orm::Config::default()).await.map_err(|e| connect_err(&e))?;
    let conn = Conn::acquire(db.pool()).await.map_err(|e| connect_err(&e))?;
    Ok((db, conn, dsn))
}

#[cfg(test)]
#[path = "tool_db_internal_tests.rs"]
mod cause_message_tests;
