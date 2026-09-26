use orm::db::Pool;

#[tokio::test]
async fn coverage_dsn_connection() {
    let driver = std::env::var("ORM_FEATURE_DATABASE").expect("ORM_FEATURE_DATABASE is required");
    let dsn = std::env::var("ORM_FEATURE_DSN").expect("ORM_FEATURE_DSN is required");
    assert!(["mysql", "postgres", "sqlite"].contains(&driver.as_str()));
    assert!(!dsn.is_empty());
    assert!(orm::Db::connect("invalid://database", 1, orm::Config::default()).await.is_err());
    let db = orm::Db::connect(&dsn, 1, orm::Config::default()).await.unwrap();
    match (driver.as_str(), db.pool()) {
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
