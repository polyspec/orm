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
        let mut connection = self.read_only_connection("SELECT 1").await?;
        let result = metadata::current_namespace(&mut connection, &self.dialect).await;
        finish_read_only(&mut connection, result).await
    }
    pub async fn describe_table(&mut self, table: &TableRef) -> Result<TableMetadata, String> {
        let mut connection = self.read_only_connection("SELECT 1").await?;
        let result = metadata::describe(&mut connection, &self.dialect, table).await;
        finish_read_only(&mut connection, result).await
    }
    /// Reads one bounded table page; this does not authorize row mutations.
    pub async fn table_page(&mut self, table: &TableRef, limit: usize, offset: u64) -> Result<TablePage, String> {
        page::validate_request(table, limit, offset)?;
        let mut connection = self.read_only_connection("SELECT 1").await?;
        let result = page::read(&mut connection, &self.dialect, table, limit, offset).await;
        finish_read_only(&mut connection, result).await
    }
    /// Executes one caller-authorized statement; this does not impose read-only isolation.
    pub async fn query(&mut self, sql: &str, params: &[crate::tool_db::P], limits: crate::tool_db::QueryLimits) -> Result<crate::tool_db::QueryResult, String> {
        let first = self.connection.query_result_bounded(sql, params, limits).await;
        match first {
            Err(error) if stale_plan(&error) => {
                // The statement may be one that cannot run in a transaction, so only a statement that failed this way, which has
                // changed nothing, runs in one (CFG-28).
                self.connection.exec("BEGIN", &[]).await.map_err(|error| error.to_string())?;
                self.connection.forget_statements().await.map_err(|error| error.to_string())?;
                self.connection.exec("DEALLOCATE ALL", &[]).await.map_err(|error| error.to_string())?;
                match self.connection.query_result_bounded(sql, params, limits).await {
                    Ok(result) => {
                        self.connection.exec("COMMIT", &[]).await.map_err(|error| error.to_string())?;
                        Ok(result)
                    }
                    Err(error) => finish_read_only(&mut self.connection, Err(error.to_string())).await,
                }
            }
            result => result.map_err(|error| error.to_string()),
        }
    }
    /// Validates read query structure and enforces a fresh database read-only scope.
    pub async fn read_only_query(
        &mut self,
        sql: &str,
        params: &[crate::tool_db::P],
        limits: crate::tool_db::QueryLimits,
    ) -> Result<crate::tool_db::QueryResult, String> {
        let mut connection = self.read_only_connection(sql).await?;
        let result = connection.query_result_values_bounded(sql, params, limits).await.map_err(catalog_query_error);
        if stopped_by_budget(&result) && self.dialect != "sqlite" {
            connection.close_now();
            return result;
        }
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
        let mut connection = self.read_only_connection(sql).await?;
        let result = connection.grid_query_values_bounded(sql, params, limits).await.map_err(catalog_query_error);
        if stopped_by_budget(&result) && self.dialect != "sqlite" {
            connection.close_now();
            return result;
        }
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
    /// The read-only connection of a read, which closes when it drops.
    async fn read_only_connection(&self, sql: &str) -> Result<Conn, String> {
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
        begin_session(&mut connection, begin).await?;
        Ok(connection)
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
/// Opens the transaction of a session. On PostgreSQL the session then releases the named statements of its server connection: a
/// catalog session runs after schema changes by design, and through PgBouncer a Parse of a text that the server connection already
/// holds never reaches the server, so a plan from before the change would fail with "cached plan must not change result type". The
/// transaction holds that server connection for the whole session (CFG-28).
pub(super) async fn begin_session(connection: &mut Conn, begin: &str) -> Result<(), String> {
    connection.exec(begin, &[]).await.map_err(|error| error.to_string())?;
    if matches!(connection, Conn::Postgres(_)) {
        connection.exec("DEALLOCATE ALL", &[]).await.map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// An error that a statement named before a schema change can raise on PostgreSQL (CFG-28).
fn stale_plan(error: &sqlx::Error) -> bool {
    let Some(database) = error.as_database_error() else {
        return false;
    };
    match database.code().as_deref() {
        Some("0A000") => database.message().contains("cached plan must not change result type"),
        Some("42883" | "42804" | "22P02" | "22003" | "22007" | "22008") => true,
        _ => false,
    }
}

/// Whether a budget stopped the read. The rest of the result is unread, and a ROLLBACK would first read all of it, so on MySQL and
/// PostgreSQL the read returns without one and closes its socket at once, and the server ends the statement and the transaction with
/// it (CFG-35). The thread id of CONNECTION_ID cannot stop the statement instead: through ProxySQL, KILL QUERY names a session
/// of ProxySQL and answers OK for any other id. SQLite stops the read with its handle, so it rolls back as usual.
fn stopped_by_budget<T>(result: &Result<T, String>) -> bool {
    matches!(result, Err(error) if error.starts_with(polyspec_orm::codes::CATALOG_LIMIT))
}

async fn finish_read_only<T>(connection: &mut Conn, result: Result<T, String>) -> Result<T, String> {
    let cleanup = connection.rollback().await.map_err(|error| error.to_string());
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
    let error = polyspec_orm::Error::from(error);
    // A write that the read-only server refuses is the query that fails, as the write of a read query is refused before it runs.
    if error.code() == polyspec_orm::codes::READ_ONLY {
        return format!("{}: the database rejected a read-only query", polyspec_orm::codes::QUERY_READ_ONLY);
    }
    // A driver error carries the code of the error catalog, as every client reports it.
    error.to_string()
}

/// The error text of a catalog write: the driver error with the code of the error catalog as its head, as the other
/// runtimes return it (CFG-33: a violated unique key is DUPLICATE_KEY; an error the catalog does not list is DRIVER).
pub(super) fn catalog_write_error(error: sqlx::Error) -> String {
    polyspec_orm::Error::from(error).to_string()
}
