use polyspec_orm::db::Pool;

// The public connection call of the crate (INT-14) on a SQLite file, which needs no server: the dsn_connection recipe runs the call on
// every database, and make feature-check runs it (contracts/fixtures/dsn_connection/dsn_connection.json).
#[tokio::main(flavor = "current_thread")]
// Requirements: CFG-1, INT-14.
async fn coverage_dsn_connection() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    assert!(polyspec_orm::Db::connect("invalid://database", 1, polyspec_orm::Config::default()).await.is_err());
    let dir = std::env::temp_dir().join(format!("orm-coverage-dsn-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let dsn = format!("sqlite://{}", dir.join("dsn.sqlite").display());
    let db = polyspec_orm::Db::connect(&dsn, 1, polyspec_orm::Config::default()).await.unwrap();
    match db.pool() {
        Pool::Sqlite(pool) => {
            sqlx::query("SELECT 1").execute(pool).await.unwrap();
        }
        _ => panic!("DSN selected the wrong database"),
    }
    db.close().await;
    std::fs::remove_dir_all(&dir).unwrap();
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("coverage_dsn": coverage_dsn_connection)
}
