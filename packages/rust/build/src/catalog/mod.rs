//! Native catalog connections selected by a DSN URI.
mod assignment_budget;
mod error;
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
pub use error::CatalogError;
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

/// A connection that the server refuses, with the code of the driver error (CFG-1).
fn connect_error(error: sqlx::Error) -> CatalogError {
    driver_error(error)
}

/// A driver error with the code of the error catalog as the head of its message, and the driver error as its cause.
fn driver_error(error: sqlx::Error) -> CatalogError {
    let error = polyspec_orm::Error::from(error);
    CatalogError::caused(error.to_string(), error)
}

/// Starts the time of CFG-35 when a write session ends, on any of its returns.
pub(super) struct ClosesOnDrop<'a>(pub(super) &'a CatalogConnection);
impl Drop for ClosesOnDrop<'_> {
    fn drop(&mut self) {
        self.0.closed_connection();
    }
}

/// How long after a close of its own a catalog tries a refused connect again (CFG-35).
const REOPEN_AFTER_CLOSE: std::time::Duration = std::time::Duration::from_secs(2);

pub struct CatalogConnection {
    /// The connection of `query`. MySQL opens it at the first `query`, so that a user whom the server allows one connection
    /// can read; the other databases hold it from the connect.
    connection: Option<Conn>,
    pool: Pool,
    dialect: String,
    /// The server, which the connection reads once when it connects (DIA-201).
    server: polyspec_orm_schema::dbspec::Server,
    /// Until when a refused connect is a socket of this catalog still on the server (CFG-35).
    reopen_until: std::sync::Mutex<std::time::Instant>,
}
impl CatalogConnection {
    pub async fn connect(raw: &str) -> Result<Self, CatalogError> {
        let parsed = polyspec_orm::db::parse_dsn(raw).map_err(|e| e.to_string())?;
        // A flowmark server runs SQL in SQLite's dialect on the corpus, so the catalog of a corpus is a SQLite catalog (DIA-185).
        let dialect = parsed.sql_driver().to_owned();
        // The catalog fixes the character set of its connection, so that the encoding is no setting of a read (INT-185): `SET NAMES
        // utf8mb4` on MySQL, and on PostgreSQL the `UTF8` client_encoding, last among the options so that no option of the DSN
        // changes it.
        let pool = match parsed.options {
            ConnectOptions::MySql(options) => Pool::MySql(
                sqlx::mysql::MySqlPoolOptions::new().max_connections(4).connect_with(options.charset("utf8mb4")).await.map_err(catalog_write_error)?,
            ),
            ConnectOptions::Postgres(options) => Pool::Postgres(
                sqlx::postgres::PgPoolOptions::new()
                    .max_connections(4)
                    .connect_with(options.options([("client_encoding", "UTF8")]))
                    .await
                    .map_err(catalog_write_error)?,
            ),
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
                        .map_err(catalog_write_error)?,
                )
            }
            ConnectOptions::Markdown(dsn) => Pool::Markdown(polyspec_orm::markdown::MarkdownPool::connect(dsn, 4).await.map_err(catalog_write_error)?),
        };
        let mut connection = Some(Conn::acquire(&pool).await.map_err(connect_error)?);
        let server = match connection.as_mut() {
            Some(connection) => metadata::server(connection, &dialect).await?,
            None => return Err("CATALOG_CONNECTION: the connection of the connect is missing".into()),
        };
        let mut reopen_until = std::time::Instant::now();
        if dialect == "mysql" {
            drop(connection.take());
            reopen_until += REOPEN_AFTER_CLOSE;
        }
        Ok(Self { connection, pool, dialect, server, reopen_until: std::sync::Mutex::new(reopen_until) })
    }
    pub fn dialect(&self) -> &str {
        &self.dialect
    }
    pub async fn current_namespace(&mut self) -> Result<String, CatalogError> {
        let mut connection = self.read_only_connection("SELECT 1").await?;
        let result = metadata::current_namespace(&mut connection, &self.dialect).await;
        self.end_read(connection, result).await
    }
    pub async fn describe_table(&mut self, table: &TableRef) -> Result<TableMetadata, CatalogError> {
        let mut connection = self.read_only_connection("SELECT 1").await?;
        let result = metadata::describe(&mut connection, &self.dialect, self.server, table).await;
        self.end_read(connection, result).await
    }
    /// Reads one bounded table page; this does not authorize row mutations.
    pub async fn table_page(&mut self, table: &TableRef, limit: usize, offset: u64) -> Result<TablePage, CatalogError> {
        page::validate_request(table, limit, offset)?;
        let mut connection = self.read_only_connection("SELECT 1").await?;
        let result = page::read(&mut connection, &self.dialect, self.server, table, limit, offset).await;
        self.end_read(connection, result).await
    }
    /// Executes one caller-authorized statement; this does not impose read-only isolation.
    pub async fn query(
        &mut self,
        sql: &str,
        params: &[crate::tool_db::P],
        limits: crate::tool_db::QueryLimits,
    ) -> Result<crate::tool_db::QueryResult, CatalogError> {
        if self.connection.is_none() {
            self.connection = Some(self.open_connection().await?);
        }
        let Some(connection) = self.connection.as_mut() else {
            return Err("the catalog holds no connection".into());
        };
        let first = connection.query_result_bounded(sql, params, limits).await;
        match first {
            // MySQL reports 22003, 22007 and 22008 for the values of a statement, and it names no statement of this kind (CFG-28).
            Err(error) if matches!(connection, Conn::Postgres(_)) && polyspec_orm::db::stale_plan(&error) => {
                // The statement may be one that cannot run in a transaction, so only a statement that failed this way, which has
                // changed nothing, runs in one. BEGIN fails only in a transaction of the caller, which the failure has aborted, and
                // there the error of the statement reaches the caller (CFG-28).
                if connection.exec("BEGIN", &[]).await.is_err() {
                    return Err(CatalogError::caused(error.to_string(), error));
                }
                let forgotten = match connection.forget_statements().await {
                    Ok(()) => connection.exec("DEALLOCATE ALL", &[]).await.map(|_| ()),
                    Err(error) => Err(error),
                };
                let again = match forgotten {
                    Ok(()) => connection.query_result_bounded(sql, params, limits).await,
                    Err(error) => Err(error),
                };
                match again {
                    Ok(result) => {
                        connection.exec("COMMIT", &[]).await.map_err(|error| error.to_string())?;
                        Ok(result)
                    }
                    Err(error) => finish_read_only(connection, Err(CatalogError::caused(error.to_string(), error))).await,
                }
            }
            result => result.map_err(|error| CatalogError::caused(error.to_string(), error)),
        }
    }
    /// Validates read query structure and enforces a fresh database read-only scope.
    pub async fn read_only_query(
        &mut self,
        sql: &str,
        params: &[crate::tool_db::P],
        limits: crate::tool_db::QueryLimits,
    ) -> Result<crate::tool_db::QueryResult, CatalogError> {
        let mut connection = self.read_only_connection(sql).await?;
        let result = connection.query_result_values_bounded(sql, params, limits).await.map_err(catalog_query_error);
        self.end_read(connection, result).await
    }
    /// A read_only_query whose limits are the counts that a caller gives: an absent count is the default, and a negative count
    /// is refused with QUERY_LIMIT_INVALID before the query runs.
    pub async fn read_only_query_counted(
        &mut self,
        sql: &str,
        params: &[crate::tool_db::P],
        max_rows: Option<i64>,
        max_bytes: Option<i64>,
    ) -> Result<crate::tool_db::QueryResult, CatalogError> {
        let limits = read_limits(max_rows, max_bytes)?;
        self.read_only_query(sql, params, limits).await
    }
    /// Read-only typed grid values preserve binary cells without text coercion.
    pub async fn read_only_grid_query(
        &mut self,
        sql: &str,
        params: &[crate::tool_db::P],
        limits: crate::tool_db::QueryLimits,
    ) -> Result<crate::tool_db::GridQueryResult, CatalogError> {
        let mut connection = self.read_only_connection(sql).await?;
        let result = connection.grid_query_values_bounded(sql, params, limits).await.map_err(catalog_query_error);
        self.end_read(connection, result).await
    }
    /// A read_only_grid_query whose limits are the counts that a caller gives, refused as read_only_query_counted refuses them.
    pub async fn read_only_grid_query_counted(
        &mut self,
        sql: &str,
        params: &[crate::tool_db::P],
        max_rows: Option<i64>,
        max_bytes: Option<i64>,
    ) -> Result<crate::tool_db::GridQueryResult, CatalogError> {
        let limits = read_limits(max_rows, max_bytes)?;
        self.read_only_grid_query(sql, params, limits).await
    }
    /// Ends a read and drops its connection, which closes with the drop. A read that a budget stopped closes its socket without a
    /// rollback, whichever operation read it.
    async fn end_read<T>(&mut self, mut connection: Conn, result: Result<T, CatalogError>) -> Result<T, CatalogError> {
        if stopped_by_budget(&result) && self.dialect != "sqlite" {
            connection.close_now();
            self.closed_connection();
            return result;
        }
        let result = finish_read_only(&mut connection, result).await;
        drop(connection);
        self.closed_connection();
        result
    }
    /// Starts the time in which a refused connect of MySQL is the closed connection still on the server.
    pub(super) fn closed_connection(&self) {
        if self.dialect == "mysql" {
            *self.reopen_until.lock().unwrap() = std::time::Instant::now() + REOPEN_AFTER_CLOSE;
        }
    }
    /// Opens a connection. A socket that this catalog closed holds its place in max_user_connections until the server ends
    /// that thread. The server announces that to no one, so this is a timer: the reopen is tried again within the 2 s of CFG-35
    /// from the close (within 40 ms measured). A connect that follows no close of this catalog fails at once.
    pub(super) async fn open_connection(&self) -> Result<Conn, CatalogError> {
        let mut acquired = Conn::acquire(&self.pool).await;
        while acquired.as_ref().err().is_some_and(|error| error.to_string().contains("1226")) && std::time::Instant::now() < *self.reopen_until.lock().unwrap()
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            acquired = Conn::acquire(&self.pool).await;
        }
        acquired.map_err(connect_error)
    }
    /// The read-only connection of a read, which closes when it drops.
    async fn read_only_connection(&self, sql: &str) -> Result<Conn, CatalogError> {
        read_only::validate(sql, &self.dialect).map_err(|error| error.to_string())?;
        let mut connection = self.open_connection().await?;
        connection.discard_on_drop();
        if self.dialect == "sqlite" {
            connection.exec("PRAGMA query_only=ON", &[]).await.map_err(|error| error.to_string())?;
        }
        if self.dialect == "mysql" {
            // At REPEATABLE READ the information schema answers from the snapshot of the transaction, so a descriptor read after the rows could not differ from the one read before them (INT-121).
            connection.exec("SET TRANSACTION ISOLATION LEVEL READ COMMITTED", &[]).await.map_err(|error| error.to_string())?;
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
        pool.close().await;
    }
}
/// Opens the transaction of a session. On PostgreSQL the session then releases the named statements of its server connection: a
/// catalog session runs after schema changes by design, and through PgBouncer a Parse of a text that the server connection already
/// holds never reaches the server, so a plan from before the change would fail with "cached plan must not change result type". The
/// transaction holds that server connection for the whole session (CFG-28).
pub(super) async fn begin_session(connection: &mut Conn, begin: &str) -> Result<(), CatalogError> {
    connection.exec(begin, &[]).await.map_err(|error| error.to_string())?;
    if matches!(connection, Conn::Postgres(_)) {
        // A connection from the pool may hold statements of an earlier session: forget them on this side too, or the next use of
        // a text it remembers names a statement that the server has released.
        connection.forget_statements().await.map_err(|error| error.to_string())?;
        connection.exec("DEALLOCATE ALL", &[]).await.map_err(|error| error.to_string())?;
        // The output of every cell kind is its exact text under these settings, and each read of cells compares the settings
        // of its rows with those read here (INT-186).
        connection.fix_output_settings().await.map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Whether a budget stopped the read. The rest of the result is unread, and a ROLLBACK would first read all of it, so on MySQL and
/// PostgreSQL the read returns without one and closes its socket at once, and the server ends the statement and the transaction with
/// it (CFG-35). The thread id of CONNECTION_ID cannot stop the statement instead: through ProxySQL, KILL QUERY names a session
/// of ProxySQL and answers OK for any other id. SQLite stops the read with its handle, so it rolls back as usual.
fn stopped_by_budget<T>(result: &Result<T, CatalogError>) -> bool {
    matches!(result, Err(error) if error.message().starts_with(polyspec_orm::codes::CATALOG_LIMIT))
}

async fn finish_read_only<T>(connection: &mut Conn, result: Result<T, CatalogError>) -> Result<T, CatalogError> {
    let cleanup = connection.rollback().await.map_err(|error| error.to_string());
    match (result, cleanup) {
        (result, Ok(_)) => result,
        (Ok(_), Err(error)) => Err(format!("QUERY_READ_ONLY_CLEANUP: {error}").into()),
        (Err(error), Err(cleanup)) => {
            let message = format!("{error}; QUERY_READ_ONLY_CLEANUP: {cleanup}");
            Err(error.with_message(message))
        }
    }
}

/// The limits of a read from the counts a caller gives. An absent count is the default of the runtime, and a negative count is
/// refused with QUERY_LIMIT_INVALID; the limits are checked here, before any query runs.
fn read_limits(max_rows: Option<i64>, max_bytes: Option<i64>) -> Result<crate::tool_db::QueryLimits, CatalogError> {
    let default = crate::tool_db::QueryLimits::default();
    let count = |value: Option<i64>, otherwise: usize| match value {
        None => Ok(otherwise),
        Some(n) if n < 0 => Err(format!("{}: limits must not be negative", polyspec_orm::codes::QUERY_LIMIT_INVALID)),
        Some(n) => usize::try_from(n).map_err(|error| format!("{}: {error}", polyspec_orm::codes::QUERY_LIMIT_INVALID)),
    };
    Ok(crate::tool_db::QueryLimits { max_rows: count(max_rows, default.max_rows)?, max_bytes: count(max_bytes, default.max_bytes)? })
}

pub(super) fn catalog_query_error(error: sqlx::Error) -> CatalogError {
    // A refusal of a catalog conversion is the message of its rule (INT-165), and the failure of the driver or of a library that
    // it holds is its cause (INT-172).
    let error = match crate::tool_db::value::take_refusal(error) {
        Ok(refusal) => {
            let message = refusal.to_string();
            return match refusal.into_source() {
                Some(source) => CatalogError::caused(message, source),
                None => message.into(),
            };
        }
        Err(error) => error,
    };
    if let sqlx::Error::Decode(inner) = &error {
        let detail = inner.to_string();
        if let Some(detail) = detail.strip_prefix("TOOL_QUERY_LIMIT:") {
            return format!("{}:{detail}", polyspec_orm::codes::CATALOG_LIMIT).into();
        }
        // INT-124 and INT-125: the tool's column and statement errors keep their own codes as the head of the text.
        for code in [polyspec_orm::codes::TOOL_QUERY_STATEMENT, polyspec_orm::codes::TOOL_QUERY_COLUMNS] {
            if let Some(detail) = detail.strip_prefix(code).and_then(|rest| rest.strip_prefix(':')) {
                return format!("{code}:{detail}").into();
            }
        }
    }
    let error = polyspec_orm::Error::from(error);
    // A write that the read-only server refuses is the query that fails, as the write of a read query is refused before it runs.
    if error.code() == polyspec_orm::codes::READ_ONLY {
        return format!("{}: the database rejected a read-only query", polyspec_orm::codes::QUERY_READ_ONLY).into();
    }
    // A driver error carries the code of the error catalog, as every client reports it.
    CatalogError::caused(error.to_string(), error)
}

/// The error of a catalog write: the driver error with the code of the error catalog as its head, as the other runtimes return
/// it (CFG-33: a violated unique key is DUPLICATE_KEY; an error the catalog does not list is DRIVER).
pub(super) fn catalog_write_error(error: sqlx::Error) -> CatalogError {
    driver_error(error)
}
