//! Native catalog connections selected by a DSN URI.
mod assignment_budget;
mod insert_mysql_identity;
mod insert_mysql_locator;
mod insert_returning;
mod insert_values;
mod metadata;
mod mutation;
mod mutation_finish;
mod page;
mod read_only;
mod row_delete;
mod row_insert;
mod row_snapshot;
mod row_update;
mod temporal;
use crate::tool_db::Conn;
pub use metadata::{TableColumnMetadata, TableKind, TableMetadata, TableRef};
pub use mutation::MutationPhase;
pub use page::TablePage;
use polyspec_orm::db::{ConnectOptions, Pool};
pub use row_snapshot::RowSnapshot;

#[cfg(test)]
#[path = "../../tests/unit/read_only_disposal.rs"]
mod disposal_tests;

#[cfg(test)]
#[path = "../../tests/unit/catalog_fixtures.rs"]
mod test_fixtures;

#[cfg(test)]
#[path = "../../tests/unit/catalog_value.rs"]
mod value_tests;

#[cfg(test)]
#[path = "../../tests/unit/catalog_tool_errors.rs"]
mod tool_error_tests;

pub struct CatalogConnection {
    connection: Conn,
    pool: Pool,
    dialect: String,
}
impl CatalogConnection {
    pub async fn connect(raw: &str) -> Result<Self, String> {
        let parsed = polyspec_orm::db::parse_dsn(raw).map_err(|e| e.to_string())?;
        let dialect = parsed.driver().to_owned();
        let pool = match parsed.options {
            ConnectOptions::MySql(options) => {
                Pool::MySql(sqlx::mysql::MySqlPoolOptions::new().max_connections(4).connect_with(options).await.map_err(|e| e.to_string())?)
            }
            ConnectOptions::Postgres(options) => {
                Pool::Postgres(sqlx::postgres::PgPoolOptions::new().max_connections(4).connect_with(options).await.map_err(|e| e.to_string())?)
            }
            ConnectOptions::Sqlite(options) => {
                let metadata = std::fs::symlink_metadata(options.get_filename()).map_err(|e| format!("CONFIG: CATALOG_SQLITE_FILE: {e}"))?;
                if !metadata.is_file() {
                    return Err("CONFIG: CATALOG_SQLITE_FILE: expected an existing regular file".into());
                }
                Pool::Sqlite(
                    sqlx::sqlite::SqlitePoolOptions::new()
                        .max_connections(4)
                        .connect_with(options.create_if_missing(false))
                        .await
                        .map_err(|e| e.to_string())?,
                )
            }
            ConnectOptions::Markdown(_) => {
                return Err("CATALOG_DSN: a markdown corpus has no database catalog; give a mysql, postgres or sqlite DSN".into());
            }
        };
        let connection = Conn::acquire(&pool).await.map_err(|e| e.to_string())?;
        Ok(Self { connection, pool, dialect })
    }
    pub fn dialect(&self) -> &str {
        &self.dialect
    }
    pub async fn current_namespace(&mut self) -> Result<String, String> {
        metadata::current_namespace(&mut self.connection, &self.dialect).await
    }
    pub async fn describe_table(&mut self, table: &TableRef) -> Result<TableMetadata, String> {
        metadata::describe(&mut self.connection, &self.dialect, table).await
    }
    /// Reads one bounded table page; this does not authorize row mutations.
    pub async fn table_page(&mut self, table: &TableRef, limit: usize, offset: u64) -> Result<TablePage, String> {
        page::validate_request(table, limit, offset)?;
        let (mut connection, _) = self.read_only_connection("SELECT 1").await?;
        let result = page::read(&mut connection, &self.dialect, table, limit, offset).await;
        finish_read_only(&mut connection, result).await
    }
    /// Executes one caller-authorized statement; this does not impose read-only isolation.
    pub async fn query(&mut self, sql: &str, params: &[crate::tool_db::P], limits: crate::tool_db::QueryLimits) -> Result<crate::tool_db::QueryResult, String> {
        self.connection.query_result_bounded(sql, params, limits).await.map_err(|error| error.to_string())
    }
    /// Validates read query structure and enforces a fresh database read-only scope.
    pub async fn read_only_query(
        &mut self,
        sql: &str,
        params: &[crate::tool_db::P],
        limits: crate::tool_db::QueryLimits,
    ) -> Result<crate::tool_db::QueryResult, String> {
        let (mut connection, thread) = self.read_only_connection(sql).await?;
        let result = connection.query_result_values_bounded(sql, params, limits).await.map_err(catalog_query_error);
        self.stop_limited_read(thread, &result).await;
        finish_read_only(&mut connection, result).await
    }
    /// A read_only_query whose limits are the counts that a caller gives: an absent count is the default, and a negative count
    /// is refused with QUERY_LIMIT_INVALID before the query runs.
    pub async fn read_only_query_counted(
        &mut self,
        sql: &str,
        params: &[crate::tool_db::P],
        max_rows: Option<i64>,
        max_bytes: Option<i64>,
    ) -> Result<crate::tool_db::QueryResult, String> {
        let limits = read_limits(max_rows, max_bytes)?;
        self.read_only_query(sql, params, limits).await
    }
    /// Read-only typed grid values preserve binary cells without text coercion.
    pub async fn read_only_grid_query(
        &mut self,
        sql: &str,
        params: &[crate::tool_db::P],
        limits: crate::tool_db::QueryLimits,
    ) -> Result<crate::tool_db::GridQueryResult, String> {
        let (mut connection, thread) = self.read_only_connection(sql).await?;
        let result = connection.grid_query_values_bounded(sql, params, limits).await.map_err(catalog_query_error);
        self.stop_limited_read(thread, &result).await;
        finish_read_only(&mut connection, result).await
    }
    /// A read_only_grid_query whose limits are the counts that a caller gives, refused as read_only_query_counted refuses them.
    pub async fn read_only_grid_query_counted(
        &mut self,
        sql: &str,
        params: &[crate::tool_db::P],
        max_rows: Option<i64>,
        max_bytes: Option<i64>,
    ) -> Result<crate::tool_db::GridQueryResult, String> {
        let limits = read_limits(max_rows, max_bytes)?;
        self.read_only_grid_query(sql, params, limits).await
    }
    /// The read-only connection of a read, and on MySQL the thread id that a budget stop kills the read by.
    async fn read_only_connection(&self, sql: &str) -> Result<(Conn, Option<u64>), String> {
        read_only::validate(sql, &self.dialect).map_err(|error| error.to_string())?;
        let mut connection = Conn::acquire(&self.pool).await.map_err(|error| error.to_string())?;
        connection.discard_on_drop();
        if self.dialect == "sqlite" {
            connection.exec("PRAGMA query_only=ON", &[]).await.map_err(|error| error.to_string())?;
        }
        let begin = match self.dialect.as_str() {
            "mysql" => "START TRANSACTION READ ONLY",
            "postgres" => "BEGIN READ ONLY",
            _ => "BEGIN",
        };
        connection.exec(begin, &[]).await.map_err(|error| error.to_string())?;
        let thread = if matches!(connection, Conn::MySql(_)) {
            let rows = connection.query("SELECT CONNECTION_ID()", &[]).await.map_err(|error| error.to_string())?;
            match rows.as_slice() {
                [row] if row.len() == 1 => Some(row[0].int().map_err(|error| error.to_string())? as u64),
                _ => return Err("MySQL CONNECTION_ID of the read is not one value".into()),
            }
        } else {
            None
        };
        Ok((connection, thread))
    }
    /// Ends a read that a budget stopped on the server. MySQL kills the running statement by its thread id on a connection of its
    /// own, so the rollback that follows does not wait for the rest of the result. A PostgreSQL cursor ends with the rollback, and
    /// a SQLite read stops with its handle. A failure here is not reported: the budget error is.
    async fn stop_limited_read<T>(&self, thread: Option<u64>, result: &Result<T, String>) {
        let (Some(thread), Err(error)) = (thread, result) else { return };
        if !error.starts_with(polyspec_orm::codes::CATALOG_LIMIT) {
            return;
        }
        if let Ok(mut killer) = Conn::acquire(&self.pool).await {
            let _killed: Result<_, _> = killer.exec(&format!("KILL QUERY {thread}"), &[]).await;
        }
    }
    pub async fn close(self) {
        let Self { connection, pool, .. } = self;
        drop(connection);
        match pool {
            Pool::MySql(pool) => pool.close().await,
            Pool::Postgres(pool) => pool.close().await,
            Pool::Sqlite(pool) => pool.close().await,
            // connect rejects a markdown DSN, so the catalog connection has no markdown pool.
            Pool::Markdown(_) => unreachable!("a catalog connection holds a SQL pool"),
        }
    }
}
async fn finish_read_only<T>(connection: &mut Conn, result: Result<T, String>) -> Result<T, String> {
    let cleanup = connection.exec("ROLLBACK", &[]).await.map_err(|error| error.to_string());
    match (result, cleanup) {
        (result, Ok(_)) => result,
        (Ok(_), Err(error)) => Err(format!("QUERY_READ_ONLY_CLEANUP: {error}")),
        (Err(error), Err(cleanup)) => Err(format!("{error}; QUERY_READ_ONLY_CLEANUP: {cleanup}")),
    }
}

/// The limits of a read from the counts a caller gives. An absent count is the default of the runtime, and a negative count is
/// refused with QUERY_LIMIT_INVALID; the limits are checked here, before any query runs.
fn read_limits(max_rows: Option<i64>, max_bytes: Option<i64>) -> Result<crate::tool_db::QueryLimits, String> {
    let default = crate::tool_db::QueryLimits::default();
    let count = |value: Option<i64>, otherwise: usize| match value {
        None => Ok(otherwise),
        Some(n) if n < 0 => Err(format!("{}: limits must not be negative", polyspec_orm::codes::QUERY_LIMIT_INVALID)),
        Some(n) => usize::try_from(n).map_err(|error| format!("{}: {error}", polyspec_orm::codes::QUERY_LIMIT_INVALID)),
    };
    Ok(crate::tool_db::QueryLimits { max_rows: count(max_rows, default.max_rows)?, max_bytes: count(max_bytes, default.max_bytes)? })
}

pub(super) fn catalog_query_error(error: sqlx::Error) -> String {
    if let sqlx::Error::Decode(inner) = &error {
        let detail = inner.to_string();
        if let Some(detail) = detail.strip_prefix("TOOL_QUERY_LIMIT:") {
            return format!("{}:{detail}", polyspec_orm::codes::CATALOG_LIMIT);
        }
        if let Some(detail) = detail.strip_prefix("TOOL_QUERY_VALUE:") {
            return format!("{}:{detail}", polyspec_orm::codes::CATALOG_VALUE);
        }
        if let Some(detail) = detail.strip_prefix("TOOL_QUERY_TEMPORAL:") {
            return format!("{}:{detail}", polyspec_orm::codes::GRID_TEMPORAL_VALUE);
        }
        // INT-124 and INT-125: the tool's column and statement errors keep their own codes as the head of the text.
        for code in [polyspec_orm::codes::TOOL_QUERY_STATEMENT, polyspec_orm::codes::TOOL_QUERY_COLUMNS] {
            if let Some(detail) = detail.strip_prefix(code).and_then(|rest| rest.strip_prefix(':')) {
                return format!("{code}:{detail}");
            }
        }
    }
    let text = error.to_string();
    // A write that the read-only server refuses is the query that fails, as the write of a read query is refused before it runs.
    if polyspec_orm::Error::from(error).code() == polyspec_orm::codes::READ_ONLY {
        return format!("{}: the database rejected a read-only query", polyspec_orm::codes::QUERY_READ_ONLY);
    }
    text
}

/// The error text of a catalog write. A driver error that the catalog lists keeps its code as the text's head, as the
/// other runtimes return it (CFG-33: a violated unique key is DUPLICATE_KEY); every other driver error is DRIVER.
pub(super) fn catalog_write_error(error: sqlx::Error) -> String {
    let text = error.to_string();
    let code = polyspec_orm::Error::from(error).code().to_owned();
    if code == polyspec_orm::codes::DRIVER {
        return text;
    }
    format!("{code}: {text}")
}
