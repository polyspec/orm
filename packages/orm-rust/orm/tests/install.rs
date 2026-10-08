//! install은 table 이름만이 아니라 database 전체를 set과 비교한다(docs/schema.md "Schema installation").
//! contracts/fixtures/install/changed_database.json의 case마다 document를 설치한 SQLite, MySQL, PostgreSQL의 case
//! database를 statement로 ORM 밖에서 바꾸면, 같은 set의 install은 dialect의 message인 CONFIG이고 remaining query는
//! 바뀐 database를 읽는다. ORM_TEST_MYSQL_DSN이나 ORM_TEST_POSTGRES_DSN이 없으면 실패한다.

use std::collections::BTreeMap;

use polyspec_orm::db::Pool;
use polyspec_orm::dbspec::{self, Document};
use polyspec_orm::serde_json::Value;
use polyspec_orm::{Config, Db, Schema};
use polyspec_orm_case_database::CaseDatabase;

fn root() -> String {
    format!("{}/../../..", polyspec_orm_testcase::manifest_dir().display())
}

async fn exec(db: &Db, statement: &str) {
    let sql = sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned()));
    match db.pool() {
        Pool::MySql(p) => sql.execute(p).await.map(|_| ()),
        Pool::Postgres(p) => sql.execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => sql.execute(p).await.map(|_| ()),
    }
    .unwrap_or_else(|e| panic!("{statement}: {e}"))
}

async fn install_case(driver: &str, dsn: &str, vector: &Value) {
    let path = format!("{}/contracts/fixtures/{}", root(), vector["document"].as_str().unwrap());
    let text = dbspec::read_file(std::path::Path::new(&path)).unwrap_or_else(|e| panic!("{path}: {e:?}"));
    let document: Document = dbspec::parse(&text, &BTreeMap::new()).unwrap_or_else(|e| panic!("{e:?}"));
    let manifest = dbspec::manifest(&[&document]).unwrap_or_else(|e| panic!("{e:?}"));
    let leak = |s: String| -> &'static str { Box::leak(s.into_boxed_str()) };
    let schema: &'static Schema = Box::leak(Box::new(Schema::with_external(leak(manifest.manifest_text), "", leak(manifest.manifest_hash))));
    let db = Db::connect(dsn, 2, Config::default()).await.unwrap_or_else(|e| panic!("{driver}: connect: {e}"));
    db.utils().schema().install(schema).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    exec(&db, vector["statement"].as_str().unwrap()).await;
    let code = vector["expected"]["code"].as_str().unwrap();
    let want = format!("{code}: {}", vector["expected"]["message"][driver].as_str().unwrap());
    match db.utils().schema().install(schema).await {
        Err(e) if e.code() == code && e.to_string() == want => {}
        other => panic!("{driver}: install over the changed database: {other:?}, want {want}"),
    }
    exec(&db, vector["remaining"].as_str().unwrap()).await;
    db.close().await;
}

#[tokio::test]
async fn install_verifies_the_database() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let path = format!("{}/contracts/fixtures/install/changed_database.json", root());
    let fixture: Value = polyspec_orm::serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap();
    let cases = fixture["cases"].as_array().unwrap_or_else(|| panic!("{path} has no cases"));
    assert!(!cases.is_empty(), "{path} has no cases");
    for case in cases {
        assert_eq!(case["operation"], "install", "case {} has another operation", case["id"]);
        for driver in ["sqlite", "mysql", "postgres"] {
            let database = CaseDatabase::create(driver).await;
            install_case(driver, database.dsn(), case).await;
            database.drop().await;
            polyspec_orm_testcase::step(format_args!("install_verifies_the_database {} {driver}", case["id"].as_str().unwrap()));
        }
    }
}
