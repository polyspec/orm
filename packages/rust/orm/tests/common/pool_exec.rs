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
