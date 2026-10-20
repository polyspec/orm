//! audit_triggers: installs contracts/fixtures/audit.dbs, audit_columns.dbs, and restore.dbs in a seeded bench database,
//! writes with audit record transactions in the same order as Go's coverage_audit_triggers_test.go, then reads the history the trigger left,
//! and drops the installed tables and PostgreSQL trigger functions. The database ends in the state it started in.

#[path = "common/audit_rows.rs"]
mod audit_rows;
#[path = "common/restore_rows.rs"]
mod restore_rows;

use audit_rows::drop_tables;
use polyspec_orm::db::Pool;
use polyspec_orm::{Core, Db, Entity, Model, Param, Schema, Val};
use sqlx::Row;
use std::collections::BTreeMap;
use std::time::Duration;

/// The case deadline. It is wall-clock time, since it bounds what the database does.
const DEADLINE: Duration = Duration::from_secs(300);

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

/// The chosen database and DSN. It fails if either is missing.
fn feature_database() -> (String, String) {
    let driver = std::env::var("ORM_FEATURE_DATABASE")
        .expect("ORM_FEATURE_DATABASE is required; run it through make feature-check, which sets it for each coverage case");
    let dsn = std::env::var("ORM_FEATURE_DSN").expect("ORM_FEATURE_DSN is required; run it through make feature-check, which sets it for each coverage case");
    assert!(["mysql", "postgres", "sqlite"].contains(&driver.as_str()), "ORM_FEATURE_DATABASE {driver:?} is not mysql, postgres or sqlite");
    (driver, dsn)
}

/// Runs the case that installs audit.dbs in the chosen database, then drops the installed tables and functions even if the case fails,
/// and continues that failure. It fails if item, item_history, or audit already exist.
async fn with_audit(case: impl AsyncFnOnce(&str, &str)) {
    let (driver, dsn) = feature_database();
    let db = Db::connect(&dsn, 2, polyspec_orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: connect: {e}"));
    assert_eq!(db.driver(), driver, "ORM_FEATURE_DSN selects another database than ORM_FEATURE_DATABASE");
    for table in ["item", "item_history", "audit"] {
        assert!(!table_exists(&db, table).await, "{driver}: table {table} exists before the case");
    }
    // The case installs audit.dbs and writes through its own connection, which has an audit source.
    let ran = futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(case(&driver, &dsn))).await;
    drop_tables(&db, &driver).await;
    for table in ["item", "item_history", "audit"] {
        assert!(!table_exists(&db, table).await, "{driver}: table {table} remains");
    }
    db.close().await;
    if let Err(payload) = ran {
        std::panic::resume_unwind(payload);
    }
}

#[tokio::test]
// Requirements: CFG-8, DBS-87, DBS-88, DBS-89, DBS-93, DBS-117, DSL-118, DSL-126.
async fn coverage_audit_history() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    if tokio::time::timeout(DEADLINE, with_audit(audit_rows::audit_case)).await.is_err() {
        panic!("audit_history: not finished within {DEADLINE:?}");
    }
}

#[tokio::test]
// Requirements: CFG-8, DBS-87, DBS-88, DBS-93, DSL-126.
async fn coverage_audit_transaction_entry_points() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    if tokio::time::timeout(DEADLINE, with_audit(audit_rows::entry_points_case)).await.is_err() {
        panic!("audit_transaction_entry_points: not finished within {DEADLINE:?}");
    }
}

/// contracts/fixtures/audit_columns.dbs: card leaves out secret with exclude (secret), and tag uses include (label) to
/// record only label and audit columns. Audit records are kept in the audit table.
static COLUMNS_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/audit_columns.dbs"), "sha256:13919322a592623065c8646e7649b8864edceedb07851d7483d4f6f8df65e727");

/// The model that reads and writes the audit_columns tables by column name.
macro_rules! columns_model {
    ($name:ident, $entity:ident, $entity_name:literal, $columns:expr) => {
        static $entity: Entity = Entity {
            name: $entity_name,
            schema: &COLUMNS_SCHEMA,
            new: polyspec_orm::model::new_boxed::<$name>,
            collect: polyspec_orm::model::collect_boxed::<$name>,
        };

        #[derive(Clone)]
        struct $name {
            core: Core,
            values: BTreeMap<String, Val>,
        }

        impl Model for $name {
            fn entity() -> &'static Entity {
                &$entity
            }
            fn core(&self) -> &Core {
                &self.core
            }
            fn core_mut(&mut self) -> &mut Core {
                &mut self.core
            }
            fn from_core(core: Core) -> Self {
                $name { core, values: BTreeMap::new() }
            }
            fn into_core(self) -> Core {
                self.core
            }
            fn assign(&mut self, name: &str, v: Val) -> polyspec_orm::Result<bool> {
                if !$columns.contains(&name) {
                    return Ok(false);
                }
                self.values.insert(name.to_owned(), v);
                Ok(true)
            }
            fn value(&self, name: &str) -> Option<Val> {
                self.values.get(name).cloned()
            }
        }
    };
}

columns_model!(Card, CARD, "card", ["seq", "title", "secret", "audit_seq", "deleted_at"]);
columns_model!(Tag, TAG, "tag", ["id", "label", "color", "audit_seq"]);

/// A model with its values set.
fn with<M: Model>(values: &[(&str, Param)]) -> M {
    let mut row = M::from_core(Core::new(M::entity()));
    for (column, value) in values {
        row.core_mut().set(column, value.clone());
    }
    row
}

/// Reads the rows of a query. The query returns each value as a string or NULL, and NULL is "NULL".
async fn text_rows(db: &Db, query: &str) -> Vec<Vec<String>> {
    macro_rules! read {
        ($pool:expr) => {{
            let rows = sqlx::raw_sql(sqlx::AssertSqlSafe(query.to_owned())).fetch_all($pool).await.unwrap_or_else(|e| panic!("{query}: {e}"));
            rows.iter()
                .map(|r| {
                    (0..r.len())
                        .map(|i| r.try_get::<Option<String>, _>(i).unwrap_or_else(|e| panic!("{query}: {e}")).unwrap_or_else(|| "NULL".to_owned()))
                        .collect()
                })
                .collect()
        }};
    }
    match db.pool() {
        Pool::MySql(p) => read!(p),
        Pool::Postgres(p) => read!(p),
        Pool::Sqlite(p) => read!(p),
        Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
    }
}

/// Drops the tables made by audit_columns and the PostgreSQL trigger functions.
async fn drop_columns_tables(db: &Db, driver: &str) {
    let quote = |n: &str| if driver == "mysql" { format!("`{n}`") } else { format!("\"{n}\"") };
    let mut statements: Vec<String> =
        ["card_history", "card", "tag_history", "tag", "audit"].iter().map(|t| format!("DROP TABLE IF EXISTS {}", quote(t))).collect();
    if driver == "postgres" {
        for table in ["card", "tag"] {
            for event in ["audit_insert", "audit_update", "audit_delete"] {
                statements.push(format!("DROP FUNCTION IF EXISTS \"{table}${event}\"()"));
            }
        }
    }
    for statement in statements {
        let sql = sqlx::raw_sql(sqlx::AssertSqlSafe(statement.clone()));
        let done = match db.pool() {
            Pool::MySql(p) => sql.execute(p).await.map(|_| ()),
            Pool::Postgres(p) => sql.execute(p).await.map(|_| ()),
            Pool::Sqlite(p) => sql.execute(p).await.map(|_| ()),
            Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
        };
        done.unwrap_or_else(|e| panic!("{statement}: {e}"));
    }
}

async fn audit_selected_columns() {
    let (driver, dsn) = feature_database();
    let db = Db::connect(&dsn, 2, polyspec_orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: connect: {e}"));
    assert_eq!(db.driver(), driver, "ORM_FEATURE_DSN selects another database than ORM_FEATURE_DATABASE");
    for table in ["card", "card_history", "tag", "tag_history", "audit"] {
        assert!(!table_exists(&db, table).await, "{driver}: table {table} exists before the case");
    }
    let text = |s: &str| Param::Str(s.to_owned());
    let adb = Db::connect(&dsn, 2, audit_rows::audit_config("default")).await.unwrap_or_else(|e| panic!("{driver}: connect: {e}"));
    adb.utils().schema().install(&COLUMNS_SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    let (seq, id) = adb
        .transaction(async || {
            let card = polyspec_orm::model::create(&mut with::<Card>(&[("title", text("first")), ("secret", text("s1"))])).await?;
            let seq = card.value("seq").expect("generated seq").as_i64()?;
            let tag = polyspec_orm::model::create(&mut with::<Tag>(&[("label", text("x")), ("color", text("red"))])).await?;
            let id = tag.value("id").expect("generated id").as_i64()?;
            polyspec_orm::model::update(&mut with::<Card>(&[("seq", Param::I64(seq)), ("title", text("second")), ("secret", text("s2"))]), false).await?;
            Ok((seq, id))
        })
        .audit([("actor", "first")])
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: audit first: {e}"));
    adb.transaction(async || {
        polyspec_orm::model::delete(&with::<Card>(&[("seq", Param::I64(seq))]), false).await?;
        polyspec_orm::model::update(&mut with::<Tag>(&[("id", Param::I64(id)), ("color", text("blue"))]), false).await
    })
    .audit([("actor", "second")])
    .retry(0)
    .await
    .unwrap_or_else(|e| panic!("{driver}: audit second: {e}"));

    let (change, text_type) = if driver == "mysql" { ("`change`", "CHAR") } else { ("\"change\"", "TEXT") };
    let cast = |column: &str| format!("CAST({column} AS {text_type})");
    let columns = columns_of(&db, "card_history").await;
    assert_eq!(columns, ["history_id", "change", "previous_audit_seq", "seq", "title", "audit_seq", "deleted_at"], "{driver}: card_history columns");
    let state = "CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END";
    let query = format!(
        "SELECT {change}, {}, {}, title, {}, {state} FROM card_history ORDER BY history_id",
        cast("previous_audit_seq"),
        cast("seq"),
        cast("audit_seq")
    );
    let rows = text_rows(&db, &query).await;
    let s = seq.to_string();
    let want = [["insert", "NULL", &s, "first", "1", "live"], ["update", "1", &s, "second", "1", "live"], ["update", "1", &s, "second", "2", "deleted"]];
    assert_eq!(rows, want.map(|r| r.map(str::to_owned).to_vec()), "{driver}: card_history rows");
    let columns = columns_of(&db, "tag_history").await;
    assert_eq!(columns, ["history_id", "change", "previous_audit_seq", "label", "audit_seq"], "{driver}: tag_history columns");
    let query = format!("SELECT {change}, {}, label, {} FROM tag_history ORDER BY history_id", cast("previous_audit_seq"), cast("audit_seq"));
    let rows = text_rows(&db, &query).await;
    let want = [["insert", "NULL", "x", "1"], ["update", "1", "x", "2"]];
    assert_eq!(rows, want.map(|r| r.map(str::to_owned).to_vec()), "{driver}: tag_history rows");
    adb.close().await;
    drop_columns_tables(&db, &driver).await;
    for table in ["card", "card_history", "tag", "tag_history", "audit"] {
        assert!(!table_exists(&db, table).await, "{driver}: table {table} remains");
    }
    db.close().await;
}

/// Reads a table's column names in catalog order.
async fn columns_of(db: &Db, table: &str) -> Vec<String> {
    let query = match db.pool() {
        Pool::MySql(_) => format!("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{table}' ORDER BY ORDINAL_POSITION"),
        Pool::Postgres(_) => format!("SELECT column_name::text FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '{table}' ORDER BY ordinal_position"),
        Pool::Sqlite(_) => format!("SELECT name FROM pragma_table_info('{table}') ORDER BY cid"),
        Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
    };
    text_rows(db, &query).await.into_iter().map(|r| r[0].clone()).collect()
}

#[tokio::test]
// Requirements: DBS-85, DBS-88, DBS-93, DBS-94, DBS-96.
async fn coverage_audit_selected_columns() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    if tokio::time::timeout(DEADLINE, audit_selected_columns()).await.is_err() {
        panic!("audit_selected_columns: not finished within {DEADLINE:?}");
    }
}

/// Drops the tables made by the restore fixture and the PostgreSQL trigger functions.
async fn drop_restore_tables(db: &Db, driver: &str) {
    let quote = |n: &str| if driver == "mysql" { format!("`{n}`") } else { format!("\"{n}\"") };
    let mut statements: Vec<String> =
        ["membership_history", "membership", "label", "audit"].iter().map(|t| format!("DROP TABLE IF EXISTS {}", quote(t))).collect();
    if driver == "postgres" {
        for event in ["audit_insert", "audit_update", "audit_delete"] {
            statements.push(format!("DROP FUNCTION IF EXISTS \"membership${event}\"()"));
        }
    }
    for statement in statements {
        audit_rows::exec(db, &statement).await;
    }
}

/// Runs restore_rows::restore_case on the chosen database: an audit table with a unique key and an exclude list, and
/// a table without audit whose soft-deleted rows are restored. When done, it drops the installed tables and functions.
async fn soft_delete_restore() {
    let (driver, dsn) = feature_database();
    let db = Db::connect(&dsn, 2, polyspec_orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: connect: {e}"));
    assert_eq!(db.driver(), driver, "ORM_FEATURE_DSN selects another database than ORM_FEATURE_DATABASE");
    for table in restore_rows::TABLES {
        assert!(!table_exists(&db, table).await, "{driver}: table {table} exists before the case");
    }
    // The case runs separately so that the installed tables are dropped even on failure, and its panic continues after cleanup.
    let case = futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(restore_rows::restore_case(&driver, &dsn))).await;
    drop_restore_tables(&db, &driver).await;
    for table in restore_rows::TABLES {
        assert!(!table_exists(&db, table).await, "{driver}: table {table} remains");
    }
    db.close().await;
    if let Err(payload) = case {
        std::panic::resume_unwind(payload);
    }
}

#[tokio::test]
// Requirements: DBS-67, DBS-87, DBS-88, DBS-93, DBS-96, DBS-117, DIA-161, INT-38.
async fn coverage_soft_delete_restore() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    if tokio::time::timeout(DEADLINE, soft_delete_restore()).await.is_err() {
        panic!("soft_delete_restore: not finished within {DEADLINE:?}");
    }
}
