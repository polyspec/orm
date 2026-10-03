//! 외부 문서를 쓰는 document set을 SQLite, MySQL, PostgreSQL에서 확인한다(docs/dbspec.md "External
//! documents", contracts/fixtures/external). member set은 ext_core의 ext_account와 ext_audit을 use로 쓰고
//! ext_post와 ext_post_history만 소유한다.
//!   - 외부 table이 없으면 connect, install, add_tables_and_columns가 어떤 statement보다 먼저 CONFIG이고 member의
//!     table을 만들지 않는다.
//!   - core를 설치한 뒤 member install은 소유한 table만 만들고, 다시 하면 아무것도 바꾸지 않는다.
//!     add_tables_and_columns는 소유한 table에만 column을 더한다.
//!   - member의 audit transaction은 core가 소유한 ext_audit에 기록을 삽입한다.
//!   - 외부 문서의 쓰는 table이 database와 다르면(없는 column) CONFIG다.
//!
//! 각 case는 자기 case database(orm-case-database)에서 실행하며 ORM_TEST_MYSQL_DSN이나 ORM_TEST_POSTGRES_DSN이
//! 없으면 실패한다.

use std::collections::BTreeMap;
use std::sync::Arc;

use orm::db::Pool;
use orm::dbspec::{self, Document};
use orm::{Config, Core, Db, Entity, Model, Param, Schema, Val};
use orm_case_database::CaseDatabase;

/// contracts/fixtures/<name>.dbs의 text.
fn fixture(name: &str) -> String {
    let path = format!("{}/../../../contracts/fixtures/{name}.dbs", env!("CARGO_MANIFEST_DIR"));
    dbspec::read_file(std::path::Path::new(&path)).unwrap_or_else(|e| panic!("{path}: {e:?}"))
}

/// 소유한 문서와 외부 문서의 schema 값. generated code처럼 manifest text, external text와 그 manifestHash를
/// 가진다.
fn set_schema(owned: &[&str], external: &[&str]) -> &'static Schema {
    let texts: Vec<(String, bool)> = owned.iter().map(|n| (fixture(n), false)).chain(external.iter().map(|n| (fixture(n), true))).collect();
    let name = |text: &str| text.lines().next().unwrap().trim_start_matches("dbspec 1 ").to_owned();
    let documents: Vec<Document> = texts
        .iter()
        .map(|(text, is_external)| {
            let set: BTreeMap<String, String> = texts.iter().filter(|(other, _)| other != text).map(|(other, _)| (name(other), other.clone())).collect();
            let mut document = dbspec::parse(text, &set).unwrap_or_else(|e| panic!("{e:?}"));
            document.external = *is_external;
            document
        })
        .collect();
    let refs: Vec<&Document> = documents.iter().collect();
    let manifest = dbspec::manifest(&refs).unwrap_or_else(|e| panic!("{e:?}"));
    let leak = |s: String| -> &'static str { Box::leak(s.into_boxed_str()) };
    Box::leak(Box::new(Schema::with_external(leak(manifest.manifest_text), leak(manifest.external_text), leak(manifest.manifest_hash))))
}

/// member set의 manifest text와 external text, manifestHash. generated code처럼 상수다. external_case가
/// set_schema로 만든 값과 같은지 확인한다.
const MEMBER_EXTERNAL: &str = "dbspec 1 ext_core\n\ntable ext_account {\n  seq i64 identity\n  name varchar(64)\n  primary key (seq)\n  unique uq_ext_account_name (name)\n}\n\ntable ext_audit {\n  seq i64 identity\n  actor varchar(64)\n  primary key (seq)\n}\n";
const MEMBER_TEXT: &str = "dbspec 1 ext_member\n\nuse ext_core { ext_account, ext_audit }\n\ntable ext_post {\n  seq i64 identity\n  account_seq i64\n  title varchar(191)\n  audit_seq i64\n  primary key (seq)\n  index ix_ext_post_account (account_seq)\n  index ix_ext_post_audit (audit_seq)\n  foreign key fk_ext_post_account (account_seq) references ext_account (seq) on delete restrict on update restrict\n  foreign key fk_ext_post_audit (audit_seq) references ext_audit (seq) on delete restrict on update restrict\n  settings {\n    audit into ext_post_history column audit_seq references ext_audit action change previous previous_audit_seq\n  }\n}\n\ntable ext_post_history {\n  history_id i64 identity\n  change varchar(8)\n  previous_audit_seq i64 null\n  seq i64\n  account_seq i64\n  title varchar(191)\n  audit_seq i64\n  primary key (history_id)\n  index ix_ext_post_history_row (seq)\n}\n";
static MEMBER: Schema = Schema::with_external(MEMBER_TEXT, MEMBER_EXTERNAL, "sha256:c96bcde55bf0c8034c0b1ca46cc2d1ac097d9de4a54f55b058708eebd2f313b2");

/// member set의 ext_post를 column 이름으로 쓰는 model.
static POST: Entity = Entity { name: "ext_post", schema: &MEMBER, new: orm::model::new_boxed::<Post>, collect: orm::model::collect_boxed::<Post> };

#[derive(Clone)]
struct Post {
    core: Core,
    values: BTreeMap<String, Val>,
}

impl Model for Post {
    fn entity() -> &'static Entity {
        &POST
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        Post { core, values: BTreeMap::new() }
    }
    fn into_core(self) -> Core {
        self.core
    }
    fn assign(&mut self, name: &str, v: Val) -> orm::Result<bool> {
        self.values.insert(name.to_owned(), v);
        Ok(true)
    }
    fn value(&self, name: &str) -> Option<Val> {
        self.values.get(name).cloned()
    }
}

async fn exec(db: &Db, statement: &str) -> Result<(), sqlx::Error> {
    let sql = sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned()));
    match db.pool() {
        Pool::MySql(p) => sql.execute(p).await.map(|_| ()),
        Pool::Postgres(p) => sql.execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => sql.execute(p).await.map(|_| ()),
    }
}

async fn scalar(db: &Db, query: &str) -> i64 {
    match db.pool() {
        Pool::MySql(p) => sqlx::query_scalar(sqlx::AssertSqlSafe(query.to_owned())).fetch_one(p).await,
        Pool::Postgres(p) => sqlx::query_scalar(sqlx::AssertSqlSafe(query.to_owned())).fetch_one(p).await,
        Pool::Sqlite(p) => sqlx::query_scalar(sqlx::AssertSqlSafe(query.to_owned())).fetch_one(p).await,
    }
    .unwrap_or_else(|e| panic!("{query}: {e}"))
}

async fn text(db: &Db, query: &str) -> String {
    match db.pool() {
        Pool::MySql(p) => sqlx::query_scalar(sqlx::AssertSqlSafe(query.to_owned())).fetch_one(p).await,
        Pool::Postgres(p) => sqlx::query_scalar(sqlx::AssertSqlSafe(query.to_owned())).fetch_one(p).await,
        Pool::Sqlite(p) => sqlx::query_scalar(sqlx::AssertSqlSafe(query.to_owned())).fetch_one(p).await,
    }
    .unwrap_or_else(|e| panic!("{query}: {e}"))
}

/// CONFIG이고 message가 `message`를 담는지 확인한다.
fn expect_config<T: std::fmt::Debug>(step: &str, result: orm::Result<T>, message: &str) {
    match result {
        Err(e) if e.code() == orm::codes::CONFIG && e.to_string().contains(message) => {}
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
    let source: orm::AuditSource = Arc::new(|| Ok(vec![("actor".to_owned(), Param::from("writer"))]));
    let config = || Config { audit_source: Some(source.clone()), ..Default::default() };
    let missing =
        "the tables that the set uses from external documents differ from the database: table ext_account does not exist; table ext_audit does not exist";
    expect_config(&format!("{driver}: connect before core"), Db::connect_schema(dsn, member, 2, config()).await.map(|_| ()), missing);

    let db = Db::connect(dsn, 2, config()).await.unwrap_or_else(|e| panic!("{driver}: connect: {e}"));
    let utils = db.utils();
    let schema = utils.schema();
    let exists = async |table: &str| exec(&db, &format!("SELECT COUNT(*) FROM {table}")).await.is_ok();
    expect_config(&format!("{driver}: install before core"), schema.install(member).await, missing);
    expect_config(&format!("{driver}: add_tables_and_columns before core"), schema.add_tables_and_columns(member).await, missing);
    assert!(!exists("ext_post").await, "{driver}: ext_post exists after the refused install");

    schema.install(core).await.unwrap_or_else(|e| panic!("{driver}: install core: {e}"));
    exec(&db, "INSERT INTO ext_account (name) VALUES ('kim')").await.unwrap_or_else(|e| panic!("{driver}: insert ext_account: {e}"));
    for i in 1..=2 {
        schema.install(member).await.unwrap_or_else(|e| panic!("{driver}: install {i} of member: {e}"));
    }
    for table in ["ext_post", "ext_post_history"] {
        assert!(exists(table).await, "{driver}: {table} does not exist after the member install");
    }
    let connected = Db::connect_schema(dsn, member, 2, config()).await.unwrap_or_else(|e| panic!("{driver}: connect with core installed: {e}"));
    connected.close().await;

    // board는 같은 core를 쓰는 다른 module set이다. schema 값으로만 등록된 set이 있어도 audit 기록 table은
    // 그것을 소유한 core에서 찾는다.
    let board = set_schema(&["external/board"], &["external/core"]);
    schema.install(board).await.unwrap_or_else(|e| panic!("{driver}: install of board: {e}"));
    db.transaction(async || {
        let mut post = Post::from_core(Core::new(&POST));
        post.core_mut().set("account_seq", Param::I64(1));
        post.core_mut().set("title", Param::from("hello"));
        orm::model::create(&mut post).await.map(|_| ())
    })
    .audit(Vec::<(String, Param)>::new())
    .await
    .unwrap_or_else(|e| panic!("{driver}: audited create in the member set: {e}"));
    let audit = scalar(&db, "SELECT seq FROM ext_audit").await;
    let actor = text(&db, "SELECT actor FROM ext_audit").await;
    let recorded = scalar(&db, "SELECT audit_seq FROM ext_post_history").await;
    assert_eq!((actor.as_str(), recorded), ("writer", audit), "{driver}: the audit record of writer in the history");

    let added = schema.add_tables_and_columns(member).await.unwrap_or_else(|e| panic!("{driver}: add_tables_and_columns of member: {e}"));
    assert!(added.is_empty(), "{driver}: add_tables_and_columns of the installed member added {added:?}");
    let added = schema.add_tables_and_columns(member_v2).await.unwrap_or_else(|e| panic!("{driver}: add_tables_and_columns of member_v2: {e}"));
    assert_eq!(added, ["ext_post.summary", "ext_post_history.summary"], "{driver}: add_tables_and_columns of member_v2");
    assert_eq!(scalar(&db, "SELECT COUNT(*) FROM ext_account").await, 1, "{driver}: ext_account rows after the member changes");

    let differs = "the tables that the set uses from external documents differ from the database: column ext_account.nick does not exist";
    expect_config(&format!("{driver}: connect with a drifted external table"), Db::connect_schema(dsn, drifted, 2, config()).await.map(|_| ()), differs);
    expect_config(&format!("{driver}: install with a drifted external table"), schema.install(drifted).await, differs);
    expect_config(&format!("{driver}: add_tables_and_columns with a drifted external table"), schema.add_tables_and_columns(drifted).await, differs);
    db.close().await;
}

#[tokio::test]
async fn external_documents() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        external_case(driver, database.dsn()).await;
        database.drop().await;
        orm_testcase::step(format_args!("external_documents {driver}"));
    }
}
