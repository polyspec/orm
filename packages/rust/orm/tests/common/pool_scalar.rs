//! Reads one scalar value from a SQL pool without changing its SQLx conversion.

use polyspec_orm::db::Pool;
use polyspec_orm::Db;

pub async fn scalar<T>(db: &Db, query: &str) -> Result<T, sqlx::Error>
where
    for<'r> T: sqlx::Decode<'r, sqlx::MySql>
        + sqlx::Decode<'r, sqlx::Postgres>
        + sqlx::Decode<'r, sqlx::Sqlite>
        + sqlx::Type<sqlx::MySql>
        + sqlx::Type<sqlx::Postgres>
        + sqlx::Type<sqlx::Sqlite>
        + Send
        + Unpin,
{
    match db.pool() {
        Pool::MySql(pool) => sqlx::query_scalar::<_, T>(sqlx::AssertSqlSafe(query.to_owned())).fetch_one(pool).await,
        Pool::Postgres(pool) => sqlx::query_scalar::<_, T>(sqlx::AssertSqlSafe(query.to_owned())).fetch_one(pool).await,
        Pool::Sqlite(pool) => sqlx::query_scalar::<_, T>(sqlx::AssertSqlSafe(query.to_owned())).fetch_one(pool).await,
        Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
    }
}
