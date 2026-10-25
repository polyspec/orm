//! SQLite schema names treat underscores literally when matching the `schema__table` prefix.

use std::time::Duration;

use polyspec_orm::db::Pool;
use polyspec_orm::{Config, Db};
use polyspec_orm_case_database::CaseDatabase;
use sqlx::query;

const CASE_DEADLINE: Duration = Duration::from_secs(30);

#[tokio::test]
// Requirements: INT-57.
async fn schema_exists_escapes_underscore_sqlite() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(CASE_DEADLINE, async {
        let database = CaseDatabase::create("sqlite").await;
        let db = match Db::connect(database.dsn(), 1, Config::default()).await {
            Ok(db) => db,
            Err(error) => {
                database.drop().await;
                panic!("connect SQLite case database: {error}");
            }
        };
        let pool = match db.pool() {
            Pool::Sqlite(pool) => pool,
            _ => panic!("the SQLite case DSN selected another driver"),
        };
        let created = query(r#"CREATE TABLE "fooXbar__schema_probe" (id INTEGER)"#).execute(pool).await;
        let wildcard = db.utils().schema().exists("foo_bar").await;
        let exact = db.utils().schema().exists("fooXbar").await;
        db.close().await;
        database.drop().await;

        created.expect("create the literal-prefix probe table");
        assert!(!wildcard.expect("exists for an underscore-containing name"), "underscore is literal");
        assert!(exact.expect("exists for the exact prefix"), "the exact schema prefix exists");
    })
    .await
    .expect("the SQLite schema exists case ends");
}
