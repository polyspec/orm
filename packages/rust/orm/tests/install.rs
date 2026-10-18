//! install compares the whole database with the set, not just table names (docs/schema.md "Schema installation").
//! For each case of contracts/fixtures/install/changed_database.json, the case installs the document on SQLite, MySQL, and PostgreSQL;
//! if the database is changed outside the ORM with statements, install of the same set is CONFIG (the dialect's message), and the remaining query
//! reads the changed database. It fails if ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is missing.

use std::collections::BTreeMap;

use polyspec_orm::db::Pool;
use polyspec_orm::dbspec::{self, Document};
use polyspec_orm::serde_json::Value;
use polyspec_orm::{Config, Db, Schema};
use polyspec_orm_case_database::CaseDatabase;
use polyspec_orm_testcase::Trial;

fn root() -> String {
    format!("{}/../../..", polyspec_orm_testcase::manifest_dir().display())
}

async fn exec(db: &Db, statement: &str) {
    let sql = sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned()));
    match db.pool() {
        Pool::MySql(p) => sql.execute(p).await.map(|_| ()),
        Pool::Postgres(p) => sql.execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => sql.execute(p).await.map(|_| ()),
        Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
    }
    .unwrap_or_else(|e| panic!("{statement}: {e}"))
}

async fn install_case(driver: &str, dsn: &str, vector: &Value) {
    let path = format!("{}/contracts/fixtures/{}", root(), vector["document"].as_str().unwrap());
    let text = dbspec::read_file(std::path::Path::new(&path)).unwrap_or_else(|e| panic!("{path}: {e:?}"));
    let document: Document = dbspec::parse(&text, &BTreeMap::new()).map(|parsed| parsed.document).unwrap_or_else(|e| panic!("{e:?}"));
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

/// Each case of the fixture is the trial `install_verifies_the_database::<id>` on the three databases.
fn install_verifies_the_database() -> Vec<Trial> {
    let path = format!("{}/contracts/fixtures/install/changed_database.json", root());
    let fixture: Value = polyspec_orm::serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap();
    let cases = fixture["cases"].as_array().unwrap_or_else(|| panic!("{path} has no cases"));
    assert!(!cases.is_empty(), "{path} has no cases");
    cases
        .iter()
        .map(|case| {
            let id = case["id"].as_str().unwrap().to_owned();
            let case = case.clone();
            polyspec_orm_testcase::async_trial(format!("install_verifies_the_database::{id}"), polyspec_orm_testcase::DATABASE, move || async move {
                assert_eq!(case["operation"], "install", "case {} has another operation", case["id"]);
                for driver in ["sqlite", "mysql", "postgres"] {
                    let database = CaseDatabase::create(driver).await;
                    install_case(driver, database.dsn(), &case).await;
                    database.drop().await;
                    polyspec_orm_testcase::step(format_args!("{driver}"));
                }
            })
        })
        .collect()
}

fn main() {
    polyspec_orm_testcase::run_in_order(install_verifies_the_database());
}
