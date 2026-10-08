//! addTablesAndColumns를 SQLite, MySQL, PostgreSQL에서 확인한다(docs/schema.md, "Adding tables
//! and columns"). case database는 다른 set addcol_log의 table과 addcol set version 1의 table을
//! row와 함께 가진다. version 2로 add_tables_and_columns를 부르면 있는 table에 빠진 null이거나
//! default가 있는 column을 더하고, row를 지키며, 바뀐 audit table의 trigger가 새 column을
//! 기록하고, 없는 table을 index, foreign key, check, audit trigger와 함께 만들며, 다른 set의
//! table은 그대로 둔다. 다시 부르면 아무것도 더하지 않는다. 있는 table에 빠진 index는 더하고,
//! 빠진 unique key는 그 이유를 적은 SCHEMA_DIFFERS다. 다른 차이가 있는 set은 아무것도
//! 바꾸기 전에 SCHEMA_DIFFERS다. fixture는 contracts/fixtures/add_tables_and_columns/*.dbs다. 각
//! case는 자기 case database(polyspec-orm-case-database)에서 실행하며 ORM_TEST_MYSQL_DSN이나
//! ORM_TEST_POSTGRES_DSN이 없으면 실패한다.

use std::collections::BTreeMap;

use polyspec_orm::db::Pool;
use polyspec_orm::dbspec;
use polyspec_orm::{Db, Schema};
use polyspec_orm_case_database::CaseDatabase;

const ADDED: [&str; 11] = [
    "addcol_extra",
    "addcol_extra_history",
    "addcol_item.note",
    "addcol_item.priority",
    "addcol_item.archived",
    "addcol_item.status",
    "addcol_item_history.note",
    "addcol_item_history.priority",
    "addcol_item_history.archived",
    "addcol_item_history.status",
    "addcol_tag.color",
];
const DIFFERS: [&str; 7] = ["required", "removed", "changed", "nullable", "default", "unique", "reorder"];
/// index.dbs가 version 1에 더하는 column과 index다. column 뒤에 index가 온다.
const ADDED_INDEX: [&str; 3] = ["addcol_item.note", "addcol_item.ix_addcol_item_label", "addcol_item_history.note"];
const MISSING_UNIQUE: &str = "add_unique addcol_item.uq_addcol_item_label: a missing unique key can fail on the existing rows; add it with a plan";

/// contracts/fixtures/add_tables_and_columns/<name>.dbs의 schema 값. generated code처럼 manifest text와
/// 그 manifestHash를 가진다.
fn fixture(name: &str) -> &'static Schema {
    let path = format!("{}/../../../contracts/fixtures/add_tables_and_columns/{name}.dbs", polyspec_orm_testcase::manifest_dir().display());
    let text = dbspec::read_file(std::path::Path::new(&path)).unwrap_or_else(|e| panic!("{path}: {e:?}"));
    let document = dbspec::parse(&text, &BTreeMap::new()).unwrap_or_else(|e| panic!("{path}: {e:?}"));
    let manifest = dbspec::manifest(&[&document]).unwrap_or_else(|e| panic!("{path}: {e:?}"));
    edited(&manifest.manifest_text, &manifest.manifest_hash)
}

/// manifest text와 선언한 hash로 만든 schema 값.
fn edited(text: &str, hash: &str) -> &'static Schema {
    Box::leak(Box::new(Schema::new(Box::leak(text.to_owned().into_boxed_str()), Box::leak(hash.to_owned().into_boxed_str()))))
}

/// 연결의 pool에서 statement 하나를 실행한다.
async fn exec(db: &Db, statement: &str) -> Result<(), sqlx::Error> {
    let sql = sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned()));
    match db.pool() {
        Pool::MySql(p) => sql.execute(p).await.map(|_| ()),
        Pool::Postgres(p) => sql.execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => sql.execute(p).await.map(|_| ()),
    }
}

/// 연결의 pool에서 query가 돌려주는 수를 읽는다.
async fn count(db: &Db, query: &str) -> Result<i64, sqlx::Error> {
    let sql = || sqlx::AssertSqlSafe(query.to_owned());
    match db.pool() {
        Pool::MySql(p) => sqlx::query_scalar::<_, i64>(sql()).fetch_one(p).await,
        Pool::Postgres(p) => sqlx::query_scalar::<_, i64>(sql()).fetch_one(p).await,
        Pool::Sqlite(p) => sqlx::query_scalar::<_, i64>(sql()).fetch_one(p).await,
    }
}

fn code<T>(r: polyspec_orm::Result<T>) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => e.code().to_owned(),
    }
}

/// case database에 addcol_log와 version 1을 설치하고 log row 하나, audit 기록 1로 item 하나, 그
/// item의 tag와 그 tag의 자식 tag를 쓴 연결. pool은 연결 하나라 add_tables_and_columns가 쓴 연결을 다음
/// statement가 다시 쓴다.
async fn installed(database: &CaseDatabase) -> Db {
    let db = Db::connect(database.dsn(), 1, polyspec_orm::Config::default()).await.unwrap();
    db.utils().schema().install(fixture("log")).await.unwrap();
    db.utils().schema().install(fixture("v1")).await.unwrap();
    for statement in [
        "INSERT INTO addcol_log_entry (message) VALUES ('kept')",
        "INSERT INTO audit (actor) VALUES ('setup')",
        "INSERT INTO addcol_item (ref, label, created_at, audit_seq) VALUES ('item-1', 'first', '2026-01-01 00:00:00.000000', 1)",
        "INSERT INTO addcol_tag (item_id, name) VALUES (1, 'red')",
        "INSERT INTO addcol_tag (item_id, parent_id, name) VALUES (1, 1, 'child')",
    ] {
        exec(&db, statement).await.unwrap_or_else(|e| panic!("{statement}: {e}"));
    }
    db
}

fn added(r: polyspec_orm::Result<Vec<String>>) -> Vec<String> {
    r.unwrap_or_else(|e| panic!("add_tables_and_columns: {e}"))
}

#[tokio::test]
async fn add_tables_and_columns() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        let db = installed(&database).await;
        assert_eq!(added(db.utils().schema().add_tables_and_columns(fixture("v2")).await), ADDED, "{driver}: add_tables_and_columns");
        // row는 그대로이고 새 column은 NULL이거나 default다.
        let items = "SELECT COUNT(*) FROM addcol_item WHERE ref = 'item-1' AND label = 'first' AND note IS NULL AND priority = 3 AND archived = false AND status = 'new'";
        assert_eq!(count(&db, items).await.unwrap(), 1, "{driver}: items with their values and the new defaults");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM addcol_tag WHERE color IS NULL").await.unwrap(), 2, "{driver}: tags with a null color");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM addcol_log_entry WHERE message = 'kept'").await.unwrap(), 1, "{driver}: log entries");
        // SQLite는 foreign key를 끄고 table을 다시 만들었다. 연결이 다시 켰는지 본다.
        assert!(exec(&db, "INSERT INTO addcol_tag (item_id, name) VALUES (999, 'orphan')").await.is_err(), "{driver}: a tag of a missing item was written");
        // audit trigger는 새 column을 기록한다.
        exec(&db, "INSERT INTO audit (actor) VALUES ('update')").await.unwrap();
        exec(&db, "UPDATE addcol_item SET note = 'later', priority = 4, audit_seq = 2 WHERE id = 1").await.unwrap();
        let history = "SELECT COUNT(*) FROM addcol_item_history WHERE history_action = 'update' AND previous_audit_seq = 1 AND audit_seq = 2 AND note = 'later' AND priority = 4 AND status = 'new'";
        assert_eq!(count(&db, history).await.unwrap(), 1, "{driver}: history rows of the update with the new columns");
        // 새 table은 index, foreign key, check, audit trigger와 함께 만들어졌다.
        exec(&db, "INSERT INTO audit (actor) VALUES ('extra')").await.unwrap();
        exec(&db, "INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (1, 'extra', 3)").await.unwrap();
        let inserted = "SELECT COUNT(*) FROM addcol_extra_history WHERE history_action = 'insert' AND previous_audit_seq IS NULL AND audit_seq = 3 AND item_id = 1 AND label = 'extra'";
        assert_eq!(count(&db, inserted).await.unwrap(), 1, "{driver}: history rows of the insert into the created table");
        for (statement, what) in [
            ("INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (999, 'orphan', 3)", "foreign key"),
            ("INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (1, '', 3)", "check"),
            ("INSERT INTO addcol_extra (item_id, label, audit_seq) VALUES (1, 'unaudited', 999)", "audit foreign key"),
            ("DELETE FROM addcol_extra", "audit delete"),
        ] {
            assert!(exec(&db, statement).await.is_err(), "{driver}: the {what} of the created table accepted {statement}");
        }
        assert_eq!(count(&db, "SELECT COUNT(*) FROM addcol_extra").await.unwrap(), 1, "{driver}: rows of the created table");
        assert!(added(db.utils().schema().add_tables_and_columns(fixture("v2")).await).is_empty(), "{driver}: repeated add_tables_and_columns");
        // 모든 table이 있으므로 install은 아무것도 바꾸지 않는다(docs/schema.md, "Schema installation").
        db.utils().schema().install(fixture("v2")).await.unwrap_or_else(|e| panic!("{driver}: install of version 2 over its tables: {e}"));
        db.close().await;
        database.drop().await;
    }
}

#[tokio::test]
async fn add_tables_and_columns_differs() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        let db = installed(&database).await;
        for name in DIFFERS {
            let result = db.utils().schema().add_tables_and_columns(fixture(name)).await;
            assert_eq!(code(result), polyspec_orm::codes::SCHEMA_DIFFERS, "{driver}: {name}");
        }
        assert_eq!(added(db.utils().schema().add_tables_and_columns(fixture("v2")).await), ADDED, "{driver}: add_tables_and_columns after the differences");
        db.close().await;
        database.drop().await;
    }
}

/// 있는 table에 빠진 index는 더하고 다시 부르면 아무것도 하지 않는다. 빠진 unique key는 있는 행에서
/// 실패할 수 있다는 이유를 적은 SCHEMA_DIFFERS다.
#[tokio::test]
async fn add_tables_and_columns_index() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        let db = installed(&database).await;
        let unique = db.utils().schema().add_tables_and_columns(fixture("unique")).await.expect_err("a missing unique key");
        assert!(
            unique.code() == polyspec_orm::codes::SCHEMA_DIFFERS && unique.to_string().contains(MISSING_UNIQUE),
            "{driver}: a missing unique key: {unique}"
        );
        assert_eq!(
            added(db.utils().schema().add_tables_and_columns(fixture("index")).await),
            ADDED_INDEX,
            "{driver}: add_tables_and_columns with a missing index"
        );
        assert!(
            added(db.utils().schema().add_tables_and_columns(fixture("index")).await).is_empty(),
            "{driver}: repeated add_tables_and_columns with the index"
        );
        // install은 database가 set과 같을 때만 아무것도 바꾸지 않는다: index가 선언대로 있다.
        db.utils().schema().install(fixture("index")).await.unwrap_or_else(|e| panic!("{driver}: install of the set with the index: {e}"));
        db.close().await;
        database.drop().await;
    }
}

#[tokio::test]
async fn add_tables_and_columns_transaction() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        let db = installed(&database).await;
        let v2 = fixture("v2");
        if driver == "postgres" {
            let result: polyspec_orm::Result<()> = db
                .transaction(async || {
                    assert_eq!(added(db.utils().schema().add_tables_and_columns(v2).await), ADDED, "{driver}: add_tables_and_columns in the transaction");
                    Err(polyspec_orm::Error::Config("roll back".into()))
                })
                .await;
            assert!(matches!(&result, Err(polyspec_orm::Error::Config(m)) if m == "roll back"), "{driver}: the transaction did not roll back: {result:?}");
        } else {
            let inside = db.transaction(async || Ok(code(db.utils().schema().add_tables_and_columns(v2).await))).await.unwrap();
            assert_eq!(inside, polyspec_orm::codes::CONFIG, "{driver}: add_tables_and_columns in a transaction");
        }
        assert_eq!(added(db.utils().schema().add_tables_and_columns(v2).await), ADDED, "{driver}: add_tables_and_columns after the transaction");
        db.close().await;
        database.drop().await;
    }
}

#[tokio::test]
async fn add_tables_and_columns_edited_manifest() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        let db = installed(&database).await;
        let v2 = fixture("v2");
        let changed = edited(&v2.text().replace(" note ", " memo "), v2.hash());
        assert_eq!(
            code(db.utils().schema().add_tables_and_columns(changed).await),
            polyspec_orm::codes::CONFIG,
            "{driver}: add_tables_and_columns of an edited manifest"
        );
        assert_eq!(added(db.utils().schema().add_tables_and_columns(v2).await), ADDED, "{driver}: add_tables_and_columns after the edited manifest");
        db.close().await;
        database.drop().await;
    }
}
