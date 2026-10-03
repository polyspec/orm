//! audit_triggers: contracts/fixtures/audit.dbspec을 시드된 bench database에 설치하고 Go의
//! audit_operation_test.go와 같은 순서로 쓴 뒤 trigger가 남긴 이력을 읽고, 설치한 table과
//! PostgreSQL trigger function을 지운다. database는 시작한 상태로 끝난다.

#[path = "common/audit_rows.rs"]
mod audit_rows;
#[path = "common/restore_rows.rs"]
mod restore_rows;

use audit_rows::{changed_item, code, drop_tables, history, new_item, Item, SCHEMA};
use orm::db::Pool;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};
use sqlx::Row;
use std::collections::BTreeMap;
use std::time::Duration;

/// case의 기한. database가 하는 일을 제한하므로 wall-clock 시간이다.
const DEADLINE: Duration = Duration::from_secs(300);

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

/// seq만 정한 item: soft delete는 이 row의 deleted_at만 바꾼다.
fn item_key(seq: i64) -> Item {
    let mut row: Item = audit_rows::model();
    row.core_mut().set("seq", Param::I64(seq));
    row
}

async fn audit_history() {
    let driver = std::env::var("ORM_FEATURE_DATABASE").expect("ORM_FEATURE_DATABASE is required");
    let dsn = std::env::var("ORM_FEATURE_DSN").expect("ORM_FEATURE_DSN is required");
    assert!(["mysql", "postgres", "sqlite"].contains(&driver.as_str()), "ORM_FEATURE_DATABASE {driver:?} is not mysql, postgres or sqlite");
    let db = Db::connect(&dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: connect: {e}"));
    assert_eq!(db.driver(), driver, "ORM_FEATURE_DSN selects another database than ORM_FEATURE_DATABASE");
    for table in ["item", "item_history"] {
        assert!(!table_exists(&db, table).await, "{driver}: table {table} exists before the case");
    }
    db.utils().schema().install(&SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));

    let mut outside = new_item("outside");
    outside.core_mut().connect(&db);
    assert_eq!(code(orm::model::create(&mut outside).await), orm::codes::CONFIG, "{driver}: insert outside a transaction");
    let seq = db
        .transaction(async || {
            let created = orm::model::create(&mut new_item("first")).await?;
            let seq = created.value("seq").expect("generated seq").as_i64()?;
            // nested transaction은 바깥 operation id를 쓴다.
            db.transaction(async || orm::model::update(&mut changed_item(seq, "second"), false).await).retry(0).await?;
            Ok(seq)
        })
        .operation(7)
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: operation 7: {e}"));
    let mut titled = changed_item(seq, "third");
    titled.core_mut().connect(&db);
    assert_eq!(code(orm::model::update(&mut titled, false).await), orm::codes::CONFIG, "{driver}: update without an operation id");
    db.transaction(async || orm::model::delete(&item_key(seq), false).await)
        .operation(8)
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: operation 8: {e}"));

    let rows = history(&db).await;
    let summary: Vec<(String, Option<i64>, i64, String, i64, bool)> = rows
        .iter()
        .map(|r| {
            let previous = if r["previous_operation_id"].is_null() { None } else { Some(r["previous_operation_id"].as_i64().unwrap()) };
            let text = |column: &str| r[column].as_string().unwrap();
            (text("change"), previous, r["seq"].as_i64().unwrap(), text("title"), r["operation_id"].as_i64().unwrap(), !r["deleted_at"].is_null())
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("insert".to_owned(), None, seq, "first".to_owned(), 7, false),
            ("update".to_owned(), Some(7), seq, "second".to_owned(), 7, false),
            ("update".to_owned(), Some(7), seq, "second".to_owned(), 8, true),
        ],
        "{driver}: history rows"
    );
    drop_tables(&db, &driver).await;
    for table in ["item", "item_history"] {
        assert!(!table_exists(&db, table).await, "{driver}: table {table} remains");
    }
    db.close().await;
}

#[tokio::test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_audit_history() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    if tokio::time::timeout(DEADLINE, audit_history()).await.is_err() {
        panic!("audit_history: not finished within {DEADLINE:?}");
    }
}

/// contracts/fixtures/audit_columns.dbs: card는 exclude (secret)로 secret을 빼고, tag는 include (label)로
/// label과 operation column만 기록한다.
static COLUMNS_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/audit_columns.dbs"), "sha256:b0d06035f951fad2c71cc41a8394beb1a5be61e717774bd6616bdd308d5ef7c3");

/// audit_columns의 table을 column 이름으로 읽고 쓰는 model.
macro_rules! columns_model {
    ($name:ident, $entity:ident, $entity_name:literal, $columns:expr) => {
        static $entity: Entity =
            Entity { name: $entity_name, schema: &COLUMNS_SCHEMA, new: orm::model::new_boxed::<$name>, collect: orm::model::collect_boxed::<$name> };

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
            fn assign(&mut self, name: &str, v: Val) -> orm::Result<bool> {
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

columns_model!(Card, CARD, "card", ["seq", "title", "secret", "operation_id", "deleted_at"]);
columns_model!(Tag, TAG, "tag", ["id", "label", "color", "operation_id"]);

/// 값을 정한 model.
fn with<M: Model>(values: &[(&str, Param)]) -> M {
    let mut row = M::from_core(Core::new(M::entity()));
    for (column, value) in values {
        row.core_mut().set(column, value.clone());
    }
    row
}

/// query의 row를 읽는다. query는 각 값을 문자열이나 NULL로 돌려주며, NULL은 "NULL"이다.
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
    }
}

/// audit_columns가 만든 table과 PostgreSQL trigger function을 지운다.
async fn drop_columns_tables(db: &Db, driver: &str) {
    let quote = |n: &str| if driver == "mysql" { format!("`{n}`") } else { format!("\"{n}\"") };
    let mut statements: Vec<String> = ["card_history", "card", "tag_history", "tag"].iter().map(|t| format!("DROP TABLE IF EXISTS {}", quote(t))).collect();
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
        };
        done.unwrap_or_else(|e| panic!("{statement}: {e}"));
    }
}

async fn audit_selected_columns() {
    let driver = std::env::var("ORM_FEATURE_DATABASE").expect("ORM_FEATURE_DATABASE is required");
    let dsn = std::env::var("ORM_FEATURE_DSN").expect("ORM_FEATURE_DSN is required");
    assert!(["mysql", "postgres", "sqlite"].contains(&driver.as_str()), "ORM_FEATURE_DATABASE {driver:?} is not mysql, postgres or sqlite");
    let db = Db::connect(&dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: connect: {e}"));
    assert_eq!(db.driver(), driver, "ORM_FEATURE_DSN selects another database than ORM_FEATURE_DATABASE");
    for table in ["card", "card_history", "tag", "tag_history"] {
        assert!(!table_exists(&db, table).await, "{driver}: table {table} exists before the case");
    }
    db.utils().schema().install(&COLUMNS_SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    let text = |s: &str| Param::Str(s.to_owned());
    let (seq, id) = db
        .transaction(async || {
            let card = orm::model::create(&mut with::<Card>(&[("title", text("first")), ("secret", text("s1"))])).await?;
            let seq = card.value("seq").expect("generated seq").as_i64()?;
            let tag = orm::model::create(&mut with::<Tag>(&[("label", text("x")), ("color", text("red"))])).await?;
            let id = tag.value("id").expect("generated id").as_i64()?;
            orm::model::update(&mut with::<Card>(&[("seq", Param::I64(seq)), ("title", text("second")), ("secret", text("s2"))]), false).await?;
            Ok((seq, id))
        })
        .operation(7)
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: operation 7: {e}"));
    db.transaction(async || {
        orm::model::delete(&with::<Card>(&[("seq", Param::I64(seq))]), false).await?;
        orm::model::update(&mut with::<Tag>(&[("id", Param::I64(id)), ("color", text("blue"))]), false).await
    })
    .operation(8)
    .retry(0)
    .await
    .unwrap_or_else(|e| panic!("{driver}: operation 8: {e}"));

    let (change, text_type) = if driver == "mysql" { ("`change`", "CHAR") } else { ("\"change\"", "TEXT") };
    let cast = |column: &str| format!("CAST({column} AS {text_type})");
    let columns = columns_of(&db, "card_history").await;
    assert_eq!(columns, ["history_id", "change", "previous_operation_id", "seq", "title", "operation_id", "deleted_at"], "{driver}: card_history columns");
    let state = "CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END";
    let query = format!(
        "SELECT {change}, {}, {}, title, {}, {state} FROM card_history ORDER BY history_id",
        cast("previous_operation_id"),
        cast("seq"),
        cast("operation_id")
    );
    let rows = text_rows(&db, &query).await;
    let s = seq.to_string();
    let want = [["insert", "NULL", &s, "first", "7", "live"], ["update", "7", &s, "second", "7", "live"], ["update", "7", &s, "second", "8", "deleted"]];
    assert_eq!(rows, want.map(|r| r.map(str::to_owned).to_vec()), "{driver}: card_history rows");
    let columns = columns_of(&db, "tag_history").await;
    assert_eq!(columns, ["history_id", "change", "previous_operation_id", "label", "operation_id"], "{driver}: tag_history columns");
    let query = format!("SELECT {change}, {}, label, {} FROM tag_history ORDER BY history_id", cast("previous_operation_id"), cast("operation_id"));
    let rows = text_rows(&db, &query).await;
    let want = [["insert", "NULL", "x", "7"], ["update", "7", "x", "8"]];
    assert_eq!(rows, want.map(|r| r.map(str::to_owned).to_vec()), "{driver}: tag_history rows");
    drop_columns_tables(&db, &driver).await;
    for table in ["card", "card_history", "tag", "tag_history"] {
        assert!(!table_exists(&db, table).await, "{driver}: table {table} remains");
    }
    db.close().await;
}

/// table의 column 이름을 catalog 순서로 읽는다.
async fn columns_of(db: &Db, table: &str) -> Vec<String> {
    let query = match db.pool() {
        Pool::MySql(_) => format!("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{table}' ORDER BY ORDINAL_POSITION"),
        Pool::Postgres(_) => format!("SELECT column_name::text FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '{table}' ORDER BY ordinal_position"),
        Pool::Sqlite(_) => format!("SELECT name FROM pragma_table_info('{table}') ORDER BY cid"),
    };
    text_rows(db, &query).await.into_iter().map(|r| r[0].clone()).collect()
}

#[tokio::test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_audit_selected_columns() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    if tokio::time::timeout(DEADLINE, audit_selected_columns()).await.is_err() {
        panic!("audit_selected_columns: not finished within {DEADLINE:?}");
    }
}

/// 고른 database에 연결하고 audit.dbs를 설치한다. item과 item_history가 미리 있으면 실패한다.
async fn installed_audit() -> (String, Db) {
    let driver = std::env::var("ORM_FEATURE_DATABASE").expect("ORM_FEATURE_DATABASE is required");
    let dsn = std::env::var("ORM_FEATURE_DSN").expect("ORM_FEATURE_DSN is required");
    assert!(["mysql", "postgres", "sqlite"].contains(&driver.as_str()), "ORM_FEATURE_DATABASE {driver:?} is not mysql, postgres or sqlite");
    let db = Db::connect(&dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: connect: {e}"));
    assert_eq!(db.driver(), driver, "ORM_FEATURE_DSN selects another database than ORM_FEATURE_DATABASE");
    for table in ["item", "item_history"] {
        assert!(!table_exists(&db, table).await, "{driver}: table {table} exists before the case");
    }
    db.utils().schema().install(&SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    (driver, db)
}

/// item_history의 (change, previous, operation, title, deleted)를 history_id 순서로 읽는다.
async fn history_summary(db: &Db) -> Vec<(String, Option<i64>, i64, String, bool)> {
    history(db)
        .await
        .iter()
        .map(|r| {
            let previous = if r["previous_operation_id"].is_null() { None } else { Some(r["previous_operation_id"].as_i64().unwrap()) };
            let text = |column: &str| r[column].as_string().unwrap();
            (text("change"), previous, r["operation_id"].as_i64().unwrap(), text("title"), !r["deleted_at"].is_null())
        })
        .collect()
}

/// 모든 transaction 진입점이 operation id를 받는다: transaction, transaction_send, transaction_once가 정한
/// id를 audit 대상 write가 쓰고, 중첩 transaction_once는 operation id를 받지 않는다.
async fn audit_operation_entry_points() {
    let (driver, db) = installed_audit().await;
    let seq = db
        .transaction(async || orm::model::create(&mut new_item("first")).await?.value("seq").expect("generated seq").as_i64())
        .operation(7)
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: transaction: {e}"));
    db.transaction_send(|| async { orm::model::update(&mut changed_item(seq, "second"), false).await })
        .operation(8)
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: transaction_send: {e}"));
    db.transaction_once(async || orm::model::update(&mut changed_item(seq, "third"), false).await)
        .operation(9)
        .await
        .unwrap_or_else(|e| panic!("{driver}: transaction_once: {e}"));
    let nested = db
        .transaction(async || match db.transaction_once(async || Ok::<(), orm::Error>(())).operation(11).await {
            Err(orm::TransactionOnceError::Orm(e)) => Err::<(), orm::Error>(e),
            other => panic!("{driver}: nested transaction_once with an operation id: {other:?}"),
        })
        .operation(10)
        .retry(0)
        .await;
    assert_eq!(code(nested), orm::codes::CONFIG, "{driver}: a nested transaction_once operation id");
    assert_eq!(
        history_summary(&db).await,
        [
            ("insert".to_owned(), None, 7, "first".to_owned(), false),
            ("update".to_owned(), Some(7), 8, "second".to_owned(), false),
            ("update".to_owned(), Some(8), 9, "third".to_owned(), false),
        ],
        "{driver}: history rows"
    );
    drop_tables(&db, &driver).await;
    for table in ["item", "item_history"] {
        assert!(!table_exists(&db, table).await, "{driver}: table {table} remains");
    }
    db.close().await;
}

#[tokio::test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_audit_operation_entry_points() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    if tokio::time::timeout(DEADLINE, audit_operation_entry_points()).await.is_err() {
        panic!("audit_operation_entry_points: not finished within {DEADLINE:?}");
    }
}

/// restore fixture가 만든 table과 PostgreSQL trigger function을 지운다.
async fn drop_restore_tables(db: &Db, driver: &str) {
    let quote = |n: &str| if driver == "mysql" { format!("`{n}`") } else { format!("\"{n}\"") };
    let mut statements: Vec<String> = ["membership_history", "membership", "label"].iter().map(|t| format!("DROP TABLE IF EXISTS {}", quote(t))).collect();
    if driver == "postgres" {
        for event in ["audit_insert", "audit_update", "audit_delete"] {
            statements.push(format!("DROP FUNCTION IF EXISTS \"membership${event}\"()"));
        }
    }
    for statement in statements {
        audit_rows::exec(db, &statement).await;
    }
}

/// 고른 database에서 restore_rows::restore_case를 실행한다: unique key와 exclude 목록을 가진 audit table과
/// audit 없는 table의 soft delete한 행을 restore로 되돌린다. 끝나면 설치한 table과 function을 지운다.
async fn soft_delete_restore() {
    let driver = std::env::var("ORM_FEATURE_DATABASE").expect("ORM_FEATURE_DATABASE is required");
    let dsn = std::env::var("ORM_FEATURE_DSN").expect("ORM_FEATURE_DSN is required");
    assert!(["mysql", "postgres", "sqlite"].contains(&driver.as_str()), "ORM_FEATURE_DATABASE {driver:?} is not mysql, postgres or sqlite");
    let db = Db::connect(&dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: connect: {e}"));
    assert_eq!(db.driver(), driver, "ORM_FEATURE_DSN selects another database than ORM_FEATURE_DATABASE");
    for table in restore_rows::TABLES {
        assert!(!table_exists(&db, table).await, "{driver}: table {table} exists before the case");
    }
    // 실패해도 설치한 table을 지우도록 case를 따로 실행하고 그 panic을 정리 뒤에 이어 간다.
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
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_soft_delete_restore() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    if tokio::time::timeout(DEADLINE, soft_delete_restore()).await.is_err() {
        panic!("soft_delete_restore: not finished within {DEADLINE:?}");
    }
}

/// 실행 중인 transaction 안에서 utils().set_operation(id)로 operation id를 정한다(audit_rows::set_operation_case).
async fn audit_operation_set_in_transaction() {
    let (driver, db) = installed_audit().await;
    audit_rows::set_operation_case(&db, &driver).await;
    drop_tables(&db, &driver).await;
    for table in ["item", "item_history"] {
        assert!(!table_exists(&db, table).await, "{driver}: table {table} remains");
    }
    db.close().await;
}

#[tokio::test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_audit_operation_set_in_transaction() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    if tokio::time::timeout(DEADLINE, audit_operation_set_in_transaction()).await.is_err() {
        panic!("audit_operation_set_in_transaction: not finished within {DEADLINE:?}");
    }
}
