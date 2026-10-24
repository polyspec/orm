//! Runs a raw SQL statement on the SQL pool of an integration-test connection.

use polyspec_orm::Db;
use polyspec_orm::db::Pool;

pub async fn exec(db: &Db, statement: &str) -> Result<(), sqlx::Error> {
    let sql = sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned()));
    match db.pool() {
        Pool::MySql(pool) => sql.execute(pool).await.map(|_| ()),
        Pool::Postgres(pool) => sql.execute(pool).await.map(|_| ()),
        Pool::Sqlite(pool) => sql.execute(pool).await.map(|_| ()),
        Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
    }
}

/// Reads one scalar value from the SQL pool without changing its SQLx conversion.
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
