//! Native catalog connections selected by a DSN URI.
mod reader;
mod read_only;
mod metadata;
mod page;
mod row_snapshot;
mod row_update;
mod mutation;
mod mutation_finish;
mod row_delete;
mod row_insert;
mod insert_mysql_identity;
pub use mutation::MutationPhase;
pub use row_snapshot::RowSnapshot;
pub use page::TablePage;
pub use metadata::{TableRef, TableMetadata, TableColumnMetadata, TableKind};
pub use reader::{read_tables, live_manifest, trigger_bodies, postgres_check_expr};
use crate::{live::Table, schema::Manifest, tool_db::Conn};
use orm::db::{ConnectOptions, Pool};
use std::collections::HashSet;

#[cfg(test)]
#[path="../../tests/unit/read_only_disposal.rs"]
mod disposal_tests;

pub struct CatalogConnection {
    connection: Conn,
    pool: Pool,
    dialect: String,
}
impl CatalogConnection {
    pub async fn connect(raw: &str) -> Result<Self, String> {
        let parsed = orm::db::parse_dsn(raw).map_err(|e| e.to_string())?;
        let dialect = parsed.driver().to_owned();
        let pool = match parsed.options {
            ConnectOptions::MySql(options) => Pool::MySql(sqlx::mysql::MySqlPoolOptions::new().max_connections(4).connect_with(options).await.map_err(|e| e.to_string())?),
            ConnectOptions::Postgres(options) => Pool::Postgres(sqlx::postgres::PgPoolOptions::new().max_connections(4).connect_with(options).await.map_err(|e| e.to_string())?),
            ConnectOptions::Sqlite(options) => {
                let metadata = std::fs::symlink_metadata(options.get_filename()).map_err(|e| format!("CATALOG_SQLITE_FILE: {e}"))?;
                if !metadata.is_file() { return Err("CATALOG_SQLITE_FILE: expected an existing regular file".into()); }
                Pool::Sqlite(sqlx::sqlite::SqlitePoolOptions::new().max_connections(4).connect_with(options.create_if_missing(false)).await.map_err(|e| e.to_string())?)
            }
        };
        let connection = Conn::acquire(&pool).await.map_err(|e| e.to_string())?;
        Ok(Self { connection, pool, dialect })
    }
    pub fn dialect(&self) -> &str { &self.dialect }
    pub async fn current_namespace(&mut self) -> Result<String, String> {
        metadata::current_namespace(&mut self.connection, &self.dialect).await
    }
    pub async fn describe_table(&mut self, table: &TableRef) -> Result<TableMetadata, String> {
        metadata::describe(&mut self.connection, &self.dialect, table).await
    }
    /// Reads one bounded table page; this does not authorize row mutations.
    pub async fn table_page(&mut self, table: &TableRef, limit: usize, offset: u64) -> Result<TablePage, String> {
        page::validate_request(table, limit, offset)?;
        let mut connection=self.read_only_connection("SELECT 1").await?;
        let result=page::read(&mut connection,&self.dialect,table,limit,offset).await;
        finish_read_only(&mut connection,result).await
    }
    pub async fn tables(&mut self, only: Option<&HashSet<String>>) -> Result<Vec<Table>, String> {
        read_tables(&mut self.connection, &self.dialect, only).await
    }
    pub async fn manifest(&mut self) -> Result<Manifest, String> {
        live_manifest(&mut self.connection, &self.dialect).await
    }
    /// Executes one caller-authorized statement; this does not impose read-only isolation.
    pub async fn query(&mut self, sql: &str, params: &[crate::tool_db::P], limits: crate::tool_db::QueryLimits) -> Result<crate::tool_db::QueryResult, String> {
        self.connection.query_result_bounded(sql, params, limits).await.map_err(|error|error.to_string())
    }
    /// Validates read query structure and enforces a fresh database read-only scope.
    pub async fn read_only_query(&mut self, sql: &str, params: &[crate::tool_db::P], limits: crate::tool_db::QueryLimits) -> Result<crate::tool_db::QueryResult, String> {
        let mut connection=self.read_only_connection(sql).await?;
        let result=connection.query_result_bounded(sql,params,limits).await.map_err(|error|error.to_string());
        finish_read_only(&mut connection,result).await
    }
    /// Read-only typed grid values preserve binary cells without text coercion.
    pub async fn read_only_grid_query(&mut self, sql: &str, params: &[crate::tool_db::P], limits: crate::tool_db::QueryLimits) -> Result<crate::tool_db::GridQueryResult, String> {
        let mut connection=self.read_only_connection(sql).await?;
        let result=connection.grid_query_bounded(sql,params,limits).await.map_err(|error|error.to_string());
        finish_read_only(&mut connection,result).await
    }
    async fn read_only_connection(&self, sql: &str) -> Result<Conn,String> {
        read_only::validate(sql,&self.dialect)?;
        let mut connection=Conn::acquire(&self.pool).await.map_err(|error|error.to_string())?;
        connection.discard_on_drop();
        if self.dialect=="sqlite" { connection.exec("PRAGMA query_only=ON",&[]).await.map_err(|error|error.to_string())?; }
        let begin=match self.dialect.as_str(){"mysql"=>"START TRANSACTION READ ONLY","postgres"=>"BEGIN READ ONLY",_=>"BEGIN"};
        connection.exec(begin,&[]).await.map_err(|error|error.to_string())?;
        Ok(connection)
    }
    pub async fn close(self) {
        let Self { connection, pool, .. } = self;
        drop(connection);
        match pool {
            Pool::MySql(pool) => pool.close().await,
            Pool::Postgres(pool) => pool.close().await,
            Pool::Sqlite(pool) => pool.close().await,
        }
    }
}
async fn finish_read_only<T>(connection:&mut Conn,result:Result<T,String>)->Result<T,String> {
    let cleanup=connection.exec("ROLLBACK",&[]).await.map_err(|error|error.to_string());
    match (result,cleanup) { (result,Ok(_))=>result,(Ok(_),Err(error))=>Err(format!("QUERY_READ_ONLY_CLEANUP: {error}")),(Err(error),Err(cleanup))=>Err(format!("{error}; QUERY_READ_ONLY_CLEANUP: {cleanup}")) }
}
