//! Database row values must report invalid and lossy conversions.

use polyspec_orm::db::Pool;
use polyspec_orm::row::{read_cell_mysql, read_cell_pg, read_cell_sqlite, Cells, Src};
use polyspec_orm::{Db, Val};

fn required_dsn(name: &str) -> String {
    std::env::var(name).ok().filter(|dsn| !dsn.is_empty()).unwrap_or_else(|| {
        panic!("{name} is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers")
    })
}

#[tokio::test]
async fn invalid_database_cells_return_decode_errors() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let mysql = Db::connect(&required_dsn("ORM_TEST_MYSQL_DSN"), 1, polyspec_orm::Config::default()).await.unwrap();
        let Pool::MySql(pool) = mysql.pool() else { panic!("MySQL DSN selected another engine") };
        let row = sqlx::query("SELECT CAST(18446744073709551615 AS UNSIGNED)").fetch_one(pool).await.unwrap();
        assert_eq!(read_cell_mysql(&row, 0).unwrap_err().code(), polyspec_orm::codes::CODEC_DECODE);
        let row = sqlx::query("SELECT 2").fetch_one(pool).await.unwrap();
        assert_eq!(Cells::Raw(row).bool(0).unwrap_err().code(), polyspec_orm::codes::CODEC_DECODE);
        mysql.close().await;

        let postgres = Db::connect(&required_dsn("ORM_TEST_POSTGRES_DSN"), 1, polyspec_orm::Config::default()).await.unwrap();
        let Pool::Postgres(pool) = postgres.pool() else { panic!("PostgreSQL DSN selected another engine") };
        let row = sqlx::query("SELECT 'NaN'::float8").fetch_one(pool).await.unwrap();
        let value = read_cell_pg(&row, 0, polyspec_orm::db::Zone).unwrap();
        assert_eq!(value.as_f64().unwrap_err().code(), polyspec_orm::codes::CODEC_DECODE);
        postgres.close().await;

        let dir = std::env::temp_dir().join(format!("orm-value-decode-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sqlite = Db::connect(&format!("sqlite://{}", dir.join("decode.sqlite").display()), 1, polyspec_orm::Config::default()).await.unwrap();
        let Pool::Sqlite(pool) = sqlite.pool() else { panic!("SQLite DSN selected another engine") };
        let row = sqlx::query("SELECT 'invalid'").fetch_one(pool).await.unwrap();
        let value = read_cell_sqlite(&row, 0).unwrap();
        assert!(matches!(value, Val::Str(_)));
        assert_eq!(value.as_i64().unwrap_err().code(), polyspec_orm::codes::CODEC_DECODE);
        sqlite.close().await;
        std::fs::remove_dir_all(dir).unwrap();
    })
    .await
    .expect("database value test timed out");
}
