//! Reads SQL query rows as text, representing SQL NULL as the string "NULL".

use crate::or_panic::OrPanic;
use polyspec_orm::db::Pool;
use polyspec_orm::Db;
use sqlx::Row;

pub async fn text_rows(db: &Db, query: &str) -> Vec<Vec<String>> {
    macro_rules! read {
        ($pool:expr) => {{
            let rows = sqlx::raw_sql(sqlx::AssertSqlSafe(query.to_owned())).fetch_all($pool).await.or_panic(|error| format!("{query}: {error}"));
            rows.iter()
                .map(|row| {
                    (0..row.len())
                        .map(|index| row.try_get::<Option<String>, _>(index).or_panic(|error| format!("{query}: {error}")).unwrap_or_else(|| "NULL".to_owned()))
                        .collect()
                })
                .collect()
        }};
    }
    match db.pool() {
        Pool::MySql(pool) => read!(pool),
        Pool::Postgres(pool) => read!(pool),
        Pool::Sqlite(pool) => read!(pool),
        Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
    }
}
