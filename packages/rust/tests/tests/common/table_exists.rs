//! Checks table presence across SQL database connections used by Rust coverage tests.

use polyspec_orm::db::Pool;
use polyspec_orm::Db;

/// Reads whether `table` exists in the connection's database, current schema, or file.
pub async fn table_exists(db: &Db, table: &str) -> bool {
    let count: i64 = match db.pool() {
        Pool::MySql(pool) => sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?")
            .bind(table)
            .fetch_one(pool)
            .await
            .unwrap(),
        Pool::Postgres(pool) => sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1")
            .bind(table)
            .fetch_one(pool)
            .await
            .unwrap(),
        Pool::Sqlite(pool) => {
            sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).fetch_one(pool).await.unwrap()
        }
        Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
    };
    count > 0
}
