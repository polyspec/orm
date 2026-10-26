//! Checks document sets that use external documents on SQLite, MySQL, and PostgreSQL (docs/spec/dbspec.md "External
//! documents", contracts/fixtures/external). The member set uses ext_account and ext_audit from ext_core via use,
//! and owns only ext_post and ext_post_history.
//!   - if the external tables are missing, install and add_tables_and_columns are CONFIG before any statement and do not create the member's tables;
//!     registration does not read the database, so connect_schema connects even if the external tables are missing or differ.
//!   - after core is installed, member install creates only the tables it owns, and running it again changes nothing.
//!     add_tables_and_columns adds columns only to the tables it owns.
//!   - a member's audit transaction inserts the record into ext_audit, which core owns.
//!   - if a table the external document writes differs from the database (a missing column), it is CONFIG.
//!
//! Each case runs in its own case database (polyspec-orm-case-database) and fails if ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN
//! is missing.

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

#[path = "common/external_schema.rs"]
mod external_schema;
use external_schema::set_schema;

#[path = "common/pool_exec.rs"]
mod pool_exec;
#[path = "common/pool_scalar.rs"]
mod pool_scalar;
use pool_exec::exec;
use pool_scalar::scalar as pool_scalar;


#[macro_use]
#[path = "common/model_row.rs"]
mod model_row;

use std::sync::Arc;

use polyspec_orm::{Config, Core, Db, Model, Param, Schema};
use polyspec_orm_case_database::CaseDatabase;

/// The manifest text, external text, and manifestHash of the member set. Like generated code, they are constants. external_case
/// checks that they match the values made by set_schema::build.
const MEMBER_EXTERNAL: &str = "dbspec 1 ext_core\n\ntable ext_account {\n  seq i64 identity\n  name varchar(64)\n  primary key (seq)\n  unique uq_ext_account_name (name)\n}\n\ntable ext_audit {\n  seq i64 identity\n  actor varchar(64)\n  primary key (seq)\n}\n";
const MEMBER_TEXT: &str = "dbspec 1 ext_member\n\nuse ext_core { ext_account, ext_audit }\n\ntable ext_post {\n  seq i64 identity\n  account_seq i64\n  title varchar(191)\n  audit_seq i64\n  primary key (seq)\n  index ix_ext_post_account (account_seq)\n  index ix_ext_post_audit (audit_seq)\n  foreign key fk_ext_post_account (account_seq) references ext_account (seq) on delete restrict on update restrict\n  foreign key fk_ext_post_audit (audit_seq) references ext_audit (seq) on delete restrict on update restrict\n  settings {\n    audit into ext_post_history column audit_seq references ext_audit action change previous previous_audit_seq\n  }\n}\n\ntable ext_post_history {\n  history_id i64 identity\n  change varchar(8)\n  previous_audit_seq i64 null\n  seq i64\n  account_seq i64\n  title varchar(191)\n  audit_seq i64\n  primary key (history_id)\n  index ix_ext_post_history_row (seq)\n}\n";
static MEMBER: Schema = Schema::with_external(MEMBER_TEXT, MEMBER_EXTERNAL, "sha256:c96bcde55bf0c8034c0b1ca46cc2d1ac097d9de4a54f55b058708eebd2f313b2");

/// The model that writes the member set's ext_post by column name.
static POST: polyspec_orm::Entity = polyspec_orm::Entity {
    name: "ext_post",
    schema: &MEMBER,
    new: polyspec_orm::model::new_boxed::<Post>,
    collect: polyspec_orm::model::collect_boxed::<Post>,
};
const POST_COLUMNS: [&str; 4] = ["seq", "account_seq", "title", "audit_seq"];

model_row!(Post, POST, POST_COLUMNS);

async fn scalar(db: &Db, query: &str) -> i64 {
    pool_scalar(db, query).await.or_panic(|e| format!("{query}: {e}"))
}

async fn text(db: &Db, query: &str) -> String {
    pool_scalar(db, query).await.or_panic(|e| format!("{query}: {e}"))
}

/// Checks that it is CONFIG and that the message contains `message`.
fn expect_config<T: std::fmt::Debug>(step: &str, result: polyspec_orm::Result<T>, message: &str) {
    match result {
        Err(e) => assert!(e.code() == polyspec_orm::codes::CONFIG && e.to_string().contains(message), "{step}: {e:?}, want CONFIG with {message:?}"),
        other => panic!("{step}: {other:?}, want CONFIG with {message:?}"),
    }
}

async fn external_case(driver: &str, dsn: &str) {
    let core = set_schema(&["external/core"], &[]);
    let member: &'static Schema = &MEMBER;
    let built = set_schema(&["external/member"], &["external/core"]);
    assert_eq!((built.text(), built.external(), built.hash()), (MEMBER.text(), MEMBER.external(), MEMBER.hash()), "the member schema value");
    let member_v2 = set_schema(&["external/member_v2"], &["external/core"]);
    let drifted = set_schema(&["external/member"], &["external/core_extra"]);
    let source: polyspec_orm::AuditSource = Arc::new(|| Ok(vec![("actor".to_owned(), Param::from("writer"))]));
    let config = || Config { audit_source: Some(source.clone()), ..Default::default() };
    let missing =
        "the tables that the set uses from external documents differ from the database: table ext_account does not exist; table ext_audit does not exist";
    Db::connect_schema(dsn, member, 2, config()).await.or_panic(|e| format!("{driver}: connect before core: {e}")).close().await;

    let db = Db::connect(dsn, 2, config()).await.or_panic(|e| format!("{driver}: connect: {e}"));
    let utils = db.utils();
    let schema = utils.schema();
    let exists = async |table: &str| exec(&db, &format!("SELECT COUNT(*) FROM {table}")).await.is_ok();
    expect_config(&format!("{driver}: install before core"), schema.install(member).await, missing);
    expect_config(&format!("{driver}: add_tables_and_columns before core"), schema.add_tables_and_columns(member).await, missing);
    assert!(!exists("ext_post").await, "{driver}: ext_post exists after the refused install");

    schema.install(core).await.or_panic(|e| format!("{driver}: install core: {e}"));
    exec(&db, "INSERT INTO ext_account (name) VALUES ('kim')").await.or_panic(|e| format!("{driver}: insert ext_account: {e}"));
    for i in 1..=2 {
        schema.install(member).await.or_panic(|e| format!("{driver}: install {i} of member: {e}"));
    }
    for table in ["ext_post", "ext_post_history"] {
        assert!(exists(table).await, "{driver}: {table} does not exist after the member install");
    }
    let connected = Db::connect_schema(dsn, member, 2, config()).await.or_panic(|e| format!("{driver}: connect with core installed: {e}"));
    connected.close().await;

    // board is another module set that uses the same core. Even if a set is registered only as a schema value, the audit record table
    // is found in the core that owns it.
    let board = set_schema(&["external/board"], &["external/core"]);
    schema.install(board).await.or_panic(|e| format!("{driver}: install of board: {e}"));
    db.transaction(async || {
        let mut post = Post::from_core(Core::new(&POST));
        post.core_mut().set("account_seq", Param::I64(1));
        post.core_mut().set("title", Param::from("hello"));
        polyspec_orm::model::create(&mut post).await.map(|_| ())
    })
    .audit(Vec::<(String, Param)>::new())
    .await
    .or_panic(|e| format!("{driver}: audited create in the member set: {e}"));
    let audit = scalar(&db, "SELECT seq FROM ext_audit").await;
    let actor = text(&db, "SELECT actor FROM ext_audit").await;
    let recorded = scalar(&db, "SELECT audit_seq FROM ext_post_history").await;
    assert_eq!((actor.as_str(), recorded), ("writer", audit), "{driver}: the audit record of writer in the history");

    let added = schema.add_tables_and_columns(member).await.or_panic(|e| format!("{driver}: add_tables_and_columns of member: {e}"));
    assert!(added.is_empty(), "{driver}: add_tables_and_columns of the installed member added {added:?}");
    let added = schema.add_tables_and_columns(member_v2).await.or_panic(|e| format!("{driver}: add_tables_and_columns of member_v2: {e}"));
    assert_eq!(added, ["ext_post.summary", "ext_post_history.summary"], "{driver}: add_tables_and_columns of member_v2");
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM ext_account").await, 1, "{driver}: ext_account rows after the member changes");

    let differs = "the tables that the set uses from external documents differ from the database: column ext_account.nick does not exist";
    Db::connect_schema(dsn, drifted, 2, config()).await.or_panic(|e| format!("{driver}: connect with a drifted external table: {e}")).close().await;
    expect_config(&format!("{driver}: install with a drifted external table"), schema.install(drifted).await, differs);
    expect_config(&format!("{driver}: add_tables_and_columns with a drifted external table"), schema.add_tables_and_columns(drifted).await, differs);
    db.close().await;
}

// Requirements: DBS-105, DBS-107, DBS-108, DBS-110, SCH-7, SCH-8, SCH-11.
#[tokio::test]
async fn external_documents() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        external_case(driver, database.dsn()).await;
        database.drop().await;
        polyspec_orm_testcase::step(format_args!("external_documents {driver}"));
    }
}
