//! schema_install: reinstalling the installed bench manifest changes nothing, and
//! installing a manifest where only some tables exist fails with CONFIG and does not create the missing tables.
use super::coverage_env::{code, connect, run};
use polyspec_orm::db::Pool;
use polyspec_orm::Db;

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

// Requirements: SCH-7, DBS-108.
#[tokio::test]
async fn coverage_schema_install_existing() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("schema_install_existing", async {
        let db = connect().await;
        db.utils().schema().install(&super::model::SCHEMA).await.unwrap();
        db.close().await;
    })
    .await;
}

/// Reads whether `table` exists in the connection's database (MySQL), current schema (PostgreSQL), or file (SQLite).
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
        Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
    };
    count > 0
}

// Requirements: SCH-10, DBS-108.
#[tokio::test]
async fn coverage_schema_install_partial() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("schema_install_partial", async {
        let document = polyspec_orm::dbspec::parse(PARTIAL, &Default::default())
            .map(|parsed| parsed.document)
            .unwrap_or_else(|errors| panic!("partial document: {errors:?}"));
        let manifest = polyspec_orm::dbspec::manifest(&[&document]).unwrap_or_else(|errors| panic!("partial manifest: {errors:?}"));
        // Schema takes 'static text, as the generated model does.
        let schema = polyspec_orm::Schema::new(Box::leak(manifest.manifest_text.into_boxed_str()), Box::leak(manifest.manifest_hash.into_boxed_str()));
        let db = connect().await;
        assert!(table_exists(&db, "user").await, "the bench user table");
        assert!(!table_exists(&db, "coverage_install_missing").await, "coverage_install_missing exists before the install");
        assert_eq!(code(db.utils().schema().install(&schema).await), polyspec_orm::codes::CONFIG, "install of a partly installed manifest");
        assert!(!table_exists(&db, "coverage_install_missing").await, "a failed install created coverage_install_missing");
        db.close().await;
    })
    .await;
}

/// External document of a document set that uses the table user of the bench database as an external document. Drift adds a column
/// that the database does not have.
const EXTERNAL_USER: &str = "dbspec 1 bench_user

table user {
  seq i64 identity
  name varchar(191)
  primary key (seq)
}
";

/// Uses EXTERNAL_USER's user and owns only coverage_external_post.
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

/// The schema value of the set where EXTERNAL_MEMBER uses `external` as an external document. Like the generated model, it is 'static text.
fn external_schema(external: &str) -> &'static polyspec_orm::Schema {
    let set = |name: &str, text: &str| std::collections::BTreeMap::from([(name.to_owned(), text.to_owned())]);
    let member = polyspec_orm::dbspec::parse(EXTERNAL_MEMBER, &set("bench_user", external))
        .map(|parsed| parsed.document)
        .unwrap_or_else(|errors| panic!("member document: {errors:?}"));
    let mut user = polyspec_orm::dbspec::parse(external, &set("coverage_external", EXTERNAL_MEMBER))
        .map(|parsed| parsed.document)
        .unwrap_or_else(|errors| panic!("external document: {errors:?}"));
    user.external = true;
    let manifest = polyspec_orm::dbspec::manifest(&[&member, &user]).unwrap_or_else(|errors| panic!("manifest: {errors:?}"));
    let leak = |s: String| -> &'static str { Box::leak(s.into_boxed_str()) };
    Box::leak(Box::new(polyspec_orm::Schema::with_external(leak(manifest.manifest_text), leak(manifest.external_text), leak(manifest.manifest_hash))))
}

/// Checks whether installing a set that uses an external document confirms the external table in the database. If an external document's column is not in the database,
/// the install fails with CONFIG and does not create the tables it owns. Registration does not read the database, so it connects with that set too.
// Requirements: DBS-107, SCH-7, SCH-11.
#[tokio::test]
async fn coverage_schema_install_external_documents() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("schema_install_external_documents", async {
        let dsn =
            std::env::var("ORM_FEATURE_DSN").expect("ORM_FEATURE_DSN is required; run it through make feature-check, which sets it for each coverage case");
        let member = external_schema(EXTERNAL_USER);
        let connected = polyspec_orm::Db::connect_schema(&dsn, member, 2, polyspec_orm::Config::default())
            .await
            .unwrap_or_else(|e| panic!("connect of a set whose external table user matches the database: {e}"));
        connected.close().await;
        let drifted = external_schema(&EXTERNAL_USER.replace("  name varchar(191)\n", "  name varchar(191)\n  coverage_missing varchar(8) null\n"));
        let want = "the tables that the set uses from external documents differ from the database: column user.coverage_missing does not exist";
        let config = |r: polyspec_orm::Result<()>| match r {
            Err(e) if e.code() == polyspec_orm::codes::CONFIG && e.to_string().contains(want) => {}
            other => panic!("{other:?}, want CONFIG with {want:?}"),
        };
        polyspec_orm::Db::connect_schema(&dsn, drifted, 2, polyspec_orm::Config::default())
            .await
            .unwrap_or_else(|e| panic!("connect of a set whose external table differs, which registering does not read: {e}"))
            .close()
            .await;
        let db = connect().await;
        config(db.utils().schema().install(drifted).await);
        assert!(!table_exists(&db, "coverage_external_post").await, "the rejected install created table coverage_external_post");
        db.close().await;
    })
    .await;
}
