//! Database access for the tools: one reserved connection, text and integer
//! values, and statements run as written.

use sqlx::pool::PoolConnection;
use sqlx::{AssertSqlSafe, Column, Executor, MySql, Postgres, Row, Sqlite, SqlSafeStr, Statement, TypeInfo, ValueRef};

use orm::db::Pool;
use futures_util::TryStreamExt;
mod limits;
mod result;
mod grid;
pub use grid::{GridCell, GridQueryResult};
pub use limits::QueryLimits;
pub use result::{QueryColumn, QueryResult};

/// A column value as the tools read it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum Val {
    Null,
    Int(i64),
    Text(String),
    Bool(bool),
}

impl Val {
    pub fn text(&self) -> String {
        match self {
            Val::Null => String::new(),
            Val::Int(n) => n.to_string(),
            Val::Text(s) => s.clone(),
            Val::Bool(b) => b.to_string(),
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
            Val::Text(s) => s.parse().map_err(|_| sqlx::Error::Decode("Invalid tool integer".into())),
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

/// A bind value.
pub enum P {
    S(String),
    I(i64),
}

pub fn s(v: &str) -> P {
    P::S(v.to_owned())
}

pub type Rows = Vec<Vec<Val>>;

fn decode_bytes(value: Option<Vec<u8>>) -> Result<Val, sqlx::Error> {
    value.map(String::from_utf8).transpose()
        .map(|value| value.map_or(Val::Null, Val::Text))
        .map_err(|error| sqlx::Error::Decode(Box::new(error)))
}

fn decode_unsigned(value: Option<u64>) -> Result<Val, sqlx::Error> {
    value.map(i64::try_from).transpose()
        .map(|value| value.map_or(Val::Null, Val::Int))
        .map_err(|error| sqlx::Error::Decode(Box::new(error)))
}

macro_rules! cell {
    ($row:expr, $i:expr) => {{
        let row = $row;
        let i = $i;
        if row.columns()[i].type_info().name().ends_with(" UNSIGNED") {
            cell_extra!(row, i)
        } else if let Ok(v) = row.try_get::<Option<String>, _>(i) {
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
            decode_bytes(v)
        } else {
            cell_extra!(row, i)
        }
    }};
}

macro_rules! cell_extra {
    ($row:expr, $i:expr) => {{
        let (row, i) = ($row, $i);
        if let Ok(v) = row.try_get::<Option<u64>, _>(i) {
            decode_unsigned(v)
        } else if let Ok(v) = row.try_get::<Option<u32>, _>(i) {
            Ok(v.map_or(Val::Null, |n| Val::Int(i64::from(n))))
        } else if let Ok(v) = row.try_get::<Option<i8>, _>(i) {
            Ok(v.map_or(Val::Null, |n| Val::Int(i64::from(n))))
        } else if let Ok(v) = row.try_get::<Option<u8>, _>(i) {
            Ok(v.map_or(Val::Null, |n| Val::Int(i64::from(n))))
        } else {
            Err(sqlx::Error::Decode("Unsupported catalog cell type".into()))
        }
    }};
}

macro_rules! cell_pg {
    ($row:expr, $i:expr) => {{
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
            decode_bytes(v)
        } else if let Ok(v) = row.try_get::<Option<i8>, _>(i) {
            Ok(v.map_or(Val::Null, |n| Val::Text((n as u8 as char).to_string())))
        } else {
            Err(sqlx::Error::Decode("Unsupported catalog cell type".into()))
        }
    }};
}

macro_rules! grid_cell {
    ($row:expr, $i:expr, $decoder:ident, $($binary:literal)|+) => {{
        let (row, i) = ($row, $i);
        let raw = row.try_get_raw(i)?;
        if raw.is_null() { Ok(GridCell::Null) }
        else if matches!(raw.type_info().name(), $($binary)|+) {
            row.try_get::<Vec<u8>, _>(i).map(GridCell::Binary)
        } else { $decoder!(row, i).map(GridCell::from) }
    }};
}
macro_rules! grid_mysql { ($row:expr, $i:expr) => { grid_cell!($row, $i, cell, "BINARY"|"VARBINARY"|"TINYBLOB"|"BLOB"|"MEDIUMBLOB"|"LONGBLOB") }; }
macro_rules! grid_pg { ($row:expr, $i:expr) => { grid_cell!($row, $i, cell_pg, "BYTEA") }; }
macro_rules! grid_sqlite { ($row:expr, $i:expr) => { grid_cell!($row, $i, cell, "BLOB") }; }

macro_rules! fetch_result {
    ($conn:expr, $sql:expr, $params:expr, $budget:expr, $cell:ident, $result:ident) => {{
        let statement = (&mut **$conn).prepare($sql.into_sql_str()).await?;
        let columns = result::columns(statement.columns().iter().map(|column| (column.name(), column.type_info().name())))?;
        let mut q = statement.query();
        for p in $params {
            q = match p { P::S(v) => q.bind(v.clone()), P::I(v) => q.bind(*v) };
        }
        let mut stream = q.fetch(&mut **$conn);
        let mut rows = Vec::new();
        while let Some(row) = stream.try_next().await? {
            $budget.check_row_count(rows.len())?;
            let values = (0..row.columns().len()).map(|i| $cell!(&row, i)).collect::<Result<Vec<_>, sqlx::Error>>()?;
            $budget.add_row(&values, rows.len())?;
            rows.push(values);
        }
        Ok($result { columns, rows })
    }};
}

/// One reserved connection of a pool.
pub enum Conn {
    MySql(PoolConnection<MySql>),
    Postgres(PoolConnection<Postgres>),
    Sqlite(PoolConnection<Sqlite>),
}

fn has_params(params: &[P]) -> bool {
    !params.is_empty()
}

impl Conn {
    /// Never return a scope-modified connection to the pool, including cancellation.
    pub(crate) fn discard_on_drop(&mut self) {
        match self { Self::MySql(c)=>c.close_on_drop(),Self::Postgres(c)=>c.close_on_drop(),Self::Sqlite(c)=>c.close_on_drop() }
    }
    pub async fn acquire(pool: &Pool) -> Result<Conn, sqlx::Error> {
        Ok(match pool {
            Pool::MySql(p) => Conn::MySql(p.acquire().await?),
            Pool::Postgres(p) => Conn::Postgres(p.acquire().await?),
            Pool::Sqlite(p) => Conn::Sqlite(p.acquire().await?),
        })
    }

    /// Runs a statement and returns the affected rows. A statement without
    /// binds is sent as written.
    pub async fn exec(&mut self, sql: &str, params: &[P]) -> Result<u64, sqlx::Error> {
        let sql = AssertSqlSafe(sql.to_owned());
        macro_rules! run {
            ($conn:expr) => {{
                if has_params(params) {
                    let mut q = sqlx::query(sql);
                    for p in params {
                        q = match p {
                            P::S(v) => q.bind(v.clone()),
                            P::I(v) => q.bind(*v),
                        };
                    }
                    q.execute(&mut **$conn).await?.rows_affected()
                } else {
                    sqlx::raw_sql(sql).execute(&mut **$conn).await?.rows_affected()
                }
            }};
        }
        Ok(match self {
            Conn::MySql(c) => run!(c),
            Conn::Postgres(c) => run!(c),
            Conn::Sqlite(c) => run!(c),
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

    /// Ordered prepared columns and bounded checked rows, including empty results.
    pub async fn query_result_bounded(&mut self, sql: &str, params: &[P], limits: QueryLimits) -> Result<QueryResult, sqlx::Error> {
        let mut budget = limits::Budget::new(limits)?;
        if orm_schema::sql::split_sql(sql).len() != 1 {
            return Err(sqlx::Error::Decode("TOOL_QUERY_STATEMENT: expected one statement".into()));
        }
        let sql = AssertSqlSafe(sql.to_owned());
        match self {
            Conn::MySql(c) => fetch_result!(c, sql, params, budget, cell, QueryResult),
            Conn::Postgres(c) => fetch_result!(c, sql, params, budget, cell_pg, QueryResult),
            Conn::Sqlite(c) => fetch_result!(c, sql, params, budget, cell, QueryResult),
        }
    }

    /// Typed SQL grid rows using the same streaming and metadata budgets.
    pub async fn grid_query_bounded(&mut self, sql: &str, params: &[P], limits: QueryLimits) -> Result<GridQueryResult, sqlx::Error> {
        let mut budget = limits::Budget::new(limits)?;
        if orm_schema::sql::split_sql(sql).len() != 1 {
            return Err(sqlx::Error::Decode("TOOL_QUERY_STATEMENT: expected one statement".into()));
        }
        let sql = AssertSqlSafe(sql.to_owned());
        match self {
            Conn::MySql(c) => fetch_result!(c, sql, params, budget, grid_mysql, GridQueryResult),
            Conn::Postgres(c) => fetch_result!(c, sql, params, budget, grid_pg, GridQueryResult),
            Conn::Sqlite(c) => fetch_result!(c, sql, params, budget, grid_sqlite, GridQueryResult),
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
        let url = url::Url::parse(raw).map_err(|_| "MIGRATION_CONFIG: dsn must be a URI using mysql://, postgres://, or sqlite://".to_owned())?;
        let dialect = url.scheme().to_lowercase();
        let host = url.host_str().unwrap_or("");
        let database = url.path().trim_matches('/');
        match dialect.as_str() {
            "mysql" if host.is_empty() || database.is_empty() => return Err("MIGRATION_CONFIG: mysql DSN must include host and database".into()),
            "postgres" if (host.is_empty() && !url.query_pairs().any(|(k, _)| k == "host")) || database.is_empty() => {
                return Err("MIGRATION_CONFIG: postgres DSN must include host and database".into())
            }
            "sqlite" if !url.path().starts_with('/') || !host.is_empty() => return Err("MIGRATION_CONFIG: sqlite DSN must be sqlite://<absolute path>".into()),
            "mysql" | "postgres" | "sqlite" => {}
            _ => return Err(format!("MIGRATION_CONFIG: unsupported DSN scheme {}; want mysql, postgres, or sqlite", crate::schema::quote_text(&dialect))),
        }
        Ok(ToolDsn { dialect, url })
    }

    /// The DSN with its password hidden.
    pub fn redacted(&self) -> String {
        let mut url = self.url.clone();
        if url.password().is_some() {
            let _ = url.set_password(Some("xxxxx"));
        }
        url.to_string()
    }
}

/// Opens the database of a DSN URI and reserves a connection.
pub async fn open(raw: &str) -> Result<(orm::Db, Conn, ToolDsn), String> {
    let dsn = ToolDsn::parse(raw)?;
    // The tools check SQLite foreign keys with foreign_key_check instead of
    // enforcing them, so a table rebuild does not fire ON DELETE actions.
    let target = if dsn.dialect == "sqlite" && !raw.contains("foreign_keys") {
        format!("{raw}{}_pragma=foreign_keys(0)", if raw.contains('?') { '&' } else { '?' })
    } else {
        raw.to_owned()
    };
    let connect_err = |e: &dyn std::fmt::Display| format!("MIGRATION_CONNECT: dsn={}: {e}", dsn.redacted());
    let db = orm::Db::connect(&target, 4, orm::Config::default()).await.map_err(|e| connect_err(&e))?;
    let conn = Conn::acquire(db.pool()).await.map_err(|e| connect_err(&e))?;
    Ok((db, conn, dsn))
}
