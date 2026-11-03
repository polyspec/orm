use polyspec_orm::dbspec::{self, CatalogQuerier, CatalogValue, Dialect, IntrospectError, Introspection};
use sqlx::{Connection, SqliteConnection};
use std::future::Future;

struct CountingSqlite<'a> {
    connection: &'a mut SqliteConnection,
    queries: usize,
}

impl CatalogQuerier for CountingSqlite<'_> {
    fn rows(&mut self, query: &str) -> impl Future<Output = Result<Vec<Vec<CatalogValue>>, sqlx::Error>> + Send {
        self.queries += 1;
        self.connection.rows(query)
    }
}

// Requirements: DIA-198.
#[tokio::test]
async fn sqlite_memory_query_count_is_independent_of_table_count() -> Result<(), IntrospectError> {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for table_count in [1, 5] {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.expect("SQLite memory connection");
        for index in 0..table_count {
            sqlx::query(sqlx::AssertSqlSafe(format!("CREATE TABLE \"item_{index}\" (\"id\" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, \"label\" TEXT NULL)")))
                .execute(&mut connection)
                .await
                .expect("create SQLite table");
        }
        {
            let mut counted = CountingSqlite { connection: &mut connection, queries: 0 };
            let Introspection { document, unsupported } = dbspec::introspect(&mut counted, Dialect::Sqlite, "introspected").await?;
            assert!(unsupported.is_empty(), "unsupported objects: {unsupported:?}");
            assert_eq!(document.tables.len(), table_count);
            assert_eq!(counted.queries, 3, "{table_count} tables: catalog query count");
        }
        connection.close().await.expect("close SQLite memory connection");
    }
    Ok(())
}
