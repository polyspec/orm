//! Checks addTablesAndColumns on SQLite, MySQL, and PostgreSQL (docs/spec/schema.md, "Adding tables
//! and columns"). The case database holds the tables of another set, addcol_log, and the tables of addcol set version 1,
//! with rows. Calling add_tables_and_columns with version 2 adds to existing tables
//! the columns that are nullable or have a default, keeps the rows, and the trigger of the changed audit table records the new column,
//! creates missing tables together with their index, foreign key, check, and audit trigger, and leaves the other set's
//! tables as they are. Calling it again adds nothing. Missing indexes on existing tables are added,
//! and a missing unique key is SCHEMA_DIFFERS with the reason. A set with other differences changes nothing
//! before it is SCHEMA_DIFFERS. The fixtures are contracts/fixtures/add_tables_and_columns/*.dbs. Each
//! case runs in its own case database (polyspec-orm-case-database) and fails if ORM_TEST_MYSQL_DSN or
//! ORM_TEST_POSTGRES_DSN is missing.

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
/// The columns and indexes that index.dbs adds to version 1. Indexes come after columns.
const ADDED_INDEX: [&str; 3] = ["addcol_item.note", "addcol_item.ix_addcol_item_label", "addcol_item_history.note"];
const MISSING_UNIQUE: &str = "add_unique addcol_item.uq_addcol_item_label: a missing unique key can fail on the existing rows; add it with a plan";

/// The schema value of contracts/fixtures/add_tables_and_columns/<name>.dbs. Like generated code, it has the manifest text and
/// that manifestHash.
fn fixture(name: &str) -> &'static Schema {
    let path = format!("{}/../../../contracts/fixtures/add_tables_and_columns/{name}.dbs", polyspec_orm_testcase::manifest_dir().display());
    let text = dbspec::read_file(std::path::Path::new(&path)).unwrap_or_else(|e| panic!("{path}: {e:?}"));
    let document = dbspec::parse(&text, &BTreeMap::new()).map(|parsed| parsed.document).unwrap_or_else(|e| panic!("{path}: {e:?}"));
    let manifest = dbspec::manifest(&[&document]).unwrap_or_else(|e| panic!("{path}: {e:?}"));
    edited(&manifest.manifest_text, &manifest.manifest_hash)
}

/// A schema value made from manifest text and the declared hash.
fn edited(text: &str, hash: &str) -> &'static Schema {
    Box::leak(Box::new(Schema::new(Box::leak(text.to_owned().into_boxed_str()), Box::leak(hash.to_owned().into_boxed_str()))))
}

/// Runs one statement from the connection's pool.
async fn exec(db: &Db, statement: &str) -> Result<(), sqlx::Error> {
    let sql = sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned()));
    match db.pool() {
        Pool::MySql(p) => sql.execute(p).await.map(|_| ()),
        Pool::Postgres(p) => sql.execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => sql.execute(p).await.map(|_| ()),
        Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
    }
}

/// Reads the number a query returns from the connection's pool.
async fn count(db: &Db, query: &str) -> Result<i64, sqlx::Error> {
    let sql = || sqlx::AssertSqlSafe(query.to_owned());
    match db.pool() {
        Pool::MySql(p) => sqlx::query_scalar::<_, i64>(sql()).fetch_one(p).await,
        Pool::Postgres(p) => sqlx::query_scalar::<_, i64>(sql()).fetch_one(p).await,
        Pool::Sqlite(p) => sqlx::query_scalar::<_, i64>(sql()).fetch_one(p).await,
        Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
    }
}

fn code<T>(r: polyspec_orm::Result<T>) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => e.code().to_owned(),
    }
}

/// Installs addcol_log and version 1 in the case database, with one log row, one item with audit record 1, and
/// the item's tag and that tag's child tag. The pool has one connection, so the connection that add_tables_and_columns used
/// is reused by the next statement.
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

// Requirements: SCH-8, SCH-10.
#[tokio::test]
async fn add_tables_and_columns() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        let db = installed(&database).await;
        assert_eq!(added(db.utils().schema().add_tables_and_columns(fixture("v2")).await), ADDED, "{driver}: add_tables_and_columns");
        // The rows are unchanged, and the new columns are NULL or the default.
        let items = "SELECT COUNT(*) FROM addcol_item WHERE ref = 'item-1' AND label = 'first' AND note IS NULL AND priority = 3 AND archived = false AND status = 'new'";
        assert_eq!(count(&db, items).await.unwrap(), 1, "{driver}: items with their values and the new defaults");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM addcol_tag WHERE color IS NULL").await.unwrap(), 2, "{driver}: tags with a null color");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM addcol_log_entry WHERE message = 'kept'").await.unwrap(), 1, "{driver}: log entries");
        // SQLite turned off foreign keys and rebuilt the table. Checks that the connection turned them back on.
        assert!(exec(&db, "INSERT INTO addcol_tag (item_id, name) VALUES (999, 'orphan')").await.is_err(), "{driver}: a tag of a missing item was written");
        // The audit trigger records the new column.
        exec(&db, "INSERT INTO audit (actor) VALUES ('update')").await.unwrap();
        exec(&db, "UPDATE addcol_item SET note = 'later', priority = 4, audit_seq = 2 WHERE id = 1").await.unwrap();
        let history = "SELECT COUNT(*) FROM addcol_item_history WHERE history_action = 'update' AND previous_audit_seq = 1 AND audit_seq = 2 AND note = 'later' AND priority = 4 AND status = 'new'";
        assert_eq!(count(&db, history).await.unwrap(), 1, "{driver}: history rows of the update with the new columns");
        // The new table was created with its index, foreign key, check, and audit trigger.
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
        // All tables exist, so install changes nothing (docs/spec/schema.md, "Schema installation").
        db.utils().schema().install(fixture("v2")).await.unwrap_or_else(|e| panic!("{driver}: install of version 2 over its tables: {e}"));
        db.close().await;
        database.drop().await;
    }
}

// Requirements: SCH-9.
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

/// Missing indexes on existing tables are added, and calling again does nothing. A missing unique key may fail on existing rows,
/// so it is SCHEMA_DIFFERS with that reason noted.
// Requirements: SCH-8, SCH-9.
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
        // install changes nothing only when the database matches the set: the indexes are there as declared.
        db.utils().schema().install(fixture("index")).await.unwrap_or_else(|e| panic!("{driver}: install of the set with the index: {e}"));
        db.close().await;
        database.drop().await;
    }
}

// Requirements: SCH-8.
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

// Requirements: SCH-7, SCH-8.
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
