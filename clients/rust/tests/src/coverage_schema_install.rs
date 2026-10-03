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

/// bench database의 table user를 외부 문서로 쓰는 document set의 외부 문서다. drift는 database에 없는 column을
/// 더한다.
const EXTERNAL_USER: &str = "dbspec 1 bench_user

table user {
  seq i64 identity
  name varchar(191)
  primary key (seq)
}
";

/// EXTERNAL_USER의 user를 쓰고 coverage_external_post만 소유한다.
const EXTERNAL_MEMBER: &str = "dbspec 1 coverage_external

use bench_user { user }

table coverage_external_post {
  seq i64 identity
  user_seq i64
  primary key (seq)
  index ix_coverage_external_post_user (user_seq)
  foreign key fk_coverage_external_post_user (user_seq) references user (seq)
}
";

/// EXTERNAL_MEMBER가 `external`을 외부 문서로 쓰는 set의 schema 값. generated model처럼 'static text다.
fn external_schema(external: &str) -> &'static orm::Schema {
    let set = |name: &str, text: &str| std::collections::BTreeMap::from([(name.to_owned(), text.to_owned())]);
    let member = orm::dbspec::parse(EXTERNAL_MEMBER, &set("bench_user", external)).unwrap_or_else(|errors| panic!("member document: {errors:?}"));
    let mut user = orm::dbspec::parse(external, &set("coverage_external", EXTERNAL_MEMBER)).unwrap_or_else(|errors| panic!("external document: {errors:?}"));
    user.external = true;
    let manifest = orm::dbspec::manifest(&[&member, &user]).unwrap_or_else(|errors| panic!("manifest: {errors:?}"));
    let leak = |s: String| -> &'static str { Box::leak(s.into_boxed_str()) };
    Box::leak(Box::new(orm::Schema::with_external(leak(manifest.manifest_text), leak(manifest.external_text), leak(manifest.manifest_hash))))
}

/// 외부 문서를 쓰는 set의 연결이 외부 table을 database에서 확인하는지 본다. 같은 table이면 연결하고, 외부 문서의
/// column이 database에 없으면 연결과 install이 CONFIG이며 소유한 table을 만들지 않는다.
#[tokio::test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_schema_install_external_documents() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    run("schema_install_external_documents", async {
        let dsn = std::env::var("ORM_FEATURE_DSN").expect("ORM_FEATURE_DSN is required");
        let member = external_schema(EXTERNAL_USER);
        let connected = orm::Db::connect_schema(&dsn, member, 2, orm::Config::default())
            .await
            .unwrap_or_else(|e| panic!("connect of a set whose external table user matches the database: {e}"));
        connected.close().await;
        let drifted = external_schema(&EXTERNAL_USER.replace("  name varchar(191)\n", "  name varchar(191)\n  coverage_missing varchar(8) null\n"));
        let want = "the tables that the set uses from external documents differ from the database: column user.coverage_missing does not exist";
        let config = |r: orm::Result<()>| match r {
            Err(e) if e.code() == orm::codes::CONFIG && e.to_string().contains(want) => {}
            other => panic!("{other:?}, want CONFIG with {want:?}"),
        };
        config(orm::Db::connect_schema(&dsn, drifted, 2, orm::Config::default()).await.map(|_| ()));
        let db = connect().await;
        config(db.utils().schema().install(drifted).await);
        assert!(!table_exists(&db, "coverage_external_post").await, "the rejected install created table coverage_external_post");
        db.close().await;
    })
    .await;
}
