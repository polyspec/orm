//! schema_install: 설치된 bench manifest를 다시 설치하면 아무것도 바꾸지 않고, table 일부만
//! 있는 manifest의 설치는 CONFIG로 실패하며 없는 table을 만들지 않는다.
use super::coverage_env::{code, connect, run};
use orm::db::Pool;
use orm::Db;

const PARTIAL: &str = "dbspec 1 partial

table user {
  seq i64 identity
  name varchar(191)
  primary key (seq)
}

table coverage_install_missing {
  seq i64 identity
  primary key (seq)
}
";

#[tokio::test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_schema_install_existing() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    run("schema_install_existing", async {
        let db = connect().await;
        db.utils().schema().install(&super::model::SCHEMA).await.unwrap();
        db.close().await;
    })
    .await;
}

/// 연결의 database(MySQL), current schema(PostgreSQL), file(SQLite)에 `table`이 있는지 읽는다.
async fn table_exists(db: &Db, table: &str) -> bool {
    let count: i64 = match db.pool() {
        Pool::MySql(p) => sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?")
            .bind(table)
            .fetch_one(p)
            .await
            .unwrap(),
        Pool::Postgres(p) => sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1")
            .bind(table)
            .fetch_one(p)
            .await
            .unwrap(),
        Pool::Sqlite(p) => sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).fetch_one(p).await.unwrap(),
    };
    count > 0
}

#[tokio::test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_schema_install_partial() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    run("schema_install_partial", async {
        let document = orm::dbspec::parse(PARTIAL, &Default::default()).unwrap_or_else(|errors| panic!("partial document: {errors:?}"));
        let manifest = orm::dbspec::manifest(&[&document]).unwrap_or_else(|errors| panic!("partial manifest: {errors:?}"));
        // Schema는 생성된 model처럼 'static text를 받는다.
        let schema = orm::Schema::new(Box::leak(manifest.manifest_text.into_boxed_str()), Box::leak(manifest.manifest_hash.into_boxed_str()));
        let db = connect().await;
        assert!(table_exists(&db, "user").await, "the bench user table");
        assert!(!table_exists(&db, "coverage_install_missing").await, "coverage_install_missing exists before the install");
        assert_eq!(code(db.utils().schema().install(&schema).await), orm::codes::CONFIG, "install of a partly installed manifest");
        assert!(!table_exists(&db, "coverage_install_missing").await, "a failed install created coverage_install_missing");
        db.close().await;
    })
    .await;
}
