//! Native catalog connections selected by a DSN URI.
mod reader;
pub use reader::{read_tables, live_manifest, trigger_bodies, postgres_check_expr};
use crate::{live::Table, schema::Manifest, tool_db::Conn};
use orm::db::{ConnectOptions, Pool};
use std::collections::HashSet;

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
    pub async fn tables(&mut self, only: Option<&HashSet<String>>) -> Result<Vec<Table>, String> {
        read_tables(&mut self.connection, &self.dialect, only).await
    }
    pub async fn manifest(&mut self) -> Result<Manifest, String> {
        live_manifest(&mut self.connection, &self.dialect).await
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
