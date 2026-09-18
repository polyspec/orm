//! Database access for the tools: one reserved connection, text and integer
//! values, and statements run as written.

use sqlx::pool::PoolConnection;
use sqlx::{AssertSqlSafe, MySql, Postgres, Row, Sqlite};

use orm::db::Pool;

/// A column value as the tools read it.
#[derive(Debug, Clone, PartialEq)]
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

    pub fn int(&self) -> i64 {
        match self {
            Val::Int(n) => *n,
            Val::Bool(b) => i64::from(*b),
            Val::Text(s) => s.parse().unwrap_or(0),
            Val::Null => 0,
        }
    }

    pub fn opt_int(&self) -> Option<i64> {
        match self {
            Val::Null => None,
            v => Some(v.int()),
        }
    }

    pub fn bool(&self) -> bool {
        match self {
            Val::Bool(b) => *b,
            Val::Int(n) => *n != 0,
            Val::Text(s) => s == "t" || s == "true" || s == "1",
            Val::Null => false,
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

macro_rules! cell {
    ($row:expr, $i:expr) => {{
        let row = $row;
        let i = $i;
        if let Ok(v) = row.try_get::<Option<String>, _>(i) {
            v.map_or(Val::Null, Val::Text)
        } else if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
            v.map_or(Val::Null, Val::Int)
        } else if let Ok(v) = row.try_get::<Option<i32>, _>(i) {
            v.map_or(Val::Null, |n| Val::Int(i64::from(n)))
        } else if let Ok(v) = row.try_get::<Option<i16>, _>(i) {
            v.map_or(Val::Null, |n| Val::Int(i64::from(n)))
        } else if let Ok(v) = row.try_get::<Option<bool>, _>(i) {
            v.map_or(Val::Null, Val::Bool)
        } else if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
            v.map_or(Val::Null, |b| Val::Text(String::from_utf8_lossy(&b).into_owned()))
        } else {
            cell_extra!(row, i)
        }
    }};
}

macro_rules! cell_extra {
    ($row:expr, $i:expr) => {{
        let (row, i) = ($row, $i);
        if let Ok(v) = row.try_get::<Option<u64>, _>(i) {
            v.map_or(Val::Null, |n| Val::Int(n as i64))
        } else if let Ok(v) = row.try_get::<Option<u32>, _>(i) {
            v.map_or(Val::Null, |n| Val::Int(i64::from(n)))
        } else if let Ok(v) = row.try_get::<Option<i8>, _>(i) {
            v.map_or(Val::Null, |n| Val::Int(i64::from(n)))
        } else if let Ok(v) = row.try_get::<Option<u8>, _>(i) {
            v.map_or(Val::Null, |n| Val::Int(i64::from(n)))
        } else {
            Val::Null
        }
    }};
}

macro_rules! cell_pg {
    ($row:expr, $i:expr) => {{
        let (row, i) = ($row, $i);
        if let Ok(v) = row.try_get::<Option<String>, _>(i) {
            v.map_or(Val::Null, Val::Text)
        } else if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
            v.map_or(Val::Null, Val::Int)
        } else if let Ok(v) = row.try_get::<Option<i32>, _>(i) {
            v.map_or(Val::Null, |n| Val::Int(i64::from(n)))
        } else if let Ok(v) = row.try_get::<Option<i16>, _>(i) {
            v.map_or(Val::Null, |n| Val::Int(i64::from(n)))
        } else if let Ok(v) = row.try_get::<Option<bool>, _>(i) {
            v.map_or(Val::Null, Val::Bool)
        } else if let Ok(v) = row.try_get::<Option<Vec<u8>>, _>(i) {
            v.map_or(Val::Null, |b| Val::Text(String::from_utf8_lossy(&b).into_owned()))
        } else if let Ok(v) = row.try_get::<Option<i8>, _>(i) {
            v.map_or(Val::Null, |n| Val::Text((n as u8 as char).to_string()))
        } else {
            Val::Null
        }
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
        let sql = AssertSqlSafe(sql.to_owned());
        macro_rules! fetch {
            ($conn:expr) => {{
                if has_params(params) {
                    let mut q = sqlx::query(sql);
                    for p in params {
                        q = match p {
                            P::S(v) => q.bind(v.clone()),
                            P::I(v) => q.bind(*v),
                        };
                    }
                    q.fetch_all(&mut **$conn).await?
                } else {
                    sqlx::raw_sql(sql).fetch_all(&mut **$conn).await?
                }
            }};
        }
        Ok(match self {
            Conn::MySql(c) => fetch!(c).iter().map(|r| (0..r.columns().len()).map(|i| cell!(r, i)).collect()).collect(),
            Conn::Postgres(c) => fetch!(c).iter().map(|r| (0..r.columns().len()).map(|i| cell_pg!(r, i)).collect()).collect(),
            Conn::Sqlite(c) => fetch!(c).iter().map(|r| (0..r.columns().len()).map(|i| cell!(r, i)).collect()).collect(),
        })
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
            "sqlite" if !url.path().starts_with('/') || !host.is_empty() => {
                return Err("MIGRATION_CONFIG: sqlite DSN must be sqlite://<absolute path>".into())
            }
            "mysql" | "postgres" | "sqlite" => {}
            _ => return Err(format!("MIGRATION_CONFIG: unsupported DSN scheme {}; want mysql, postgres, or sqlite", orm_build::schema::quote_text(&dialect))),
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
