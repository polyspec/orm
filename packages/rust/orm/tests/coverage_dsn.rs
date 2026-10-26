use polyspec_orm::db::Pool;

#[path = "common/feature_database.rs"]
mod feature_database;

// feature-check runs it by its exact name with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN, the database it started.
#[tokio::test]
// Requirements: CFG-1, INT-14.
async fn coverage_dsn_connection() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let (driver, dsn) = feature_database::selected_dsn();
    assert!(polyspec_orm::Db::connect("invalid://database", 1, polyspec_orm::Config::default()).await.is_err());
    let db = polyspec_orm::Db::connect(&dsn, 1, polyspec_orm::Config::default()).await.unwrap();
    match (driver, db.pool()) {
        ("mysql", Pool::MySql(pool)) => {
            sqlx::query("SELECT 1").execute(pool).await.unwrap();
        }
        ("postgres", Pool::Postgres(pool)) => {
            sqlx::query("SELECT 1").execute(pool).await.unwrap();
        }
        ("sqlite", Pool::Sqlite(pool)) => {
            sqlx::query("SELECT 1").execute(pool).await.unwrap();
        }
        _ => panic!("DSN selected the wrong database"),
    }
    db.close().await;
}
