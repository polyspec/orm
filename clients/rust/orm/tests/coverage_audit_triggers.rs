//! audit_triggers: contracts/fixtures/audit.dbspec을 시드된 bench database에 설치하고 Go의
//! audit_operation_test.go와 같은 순서로 쓴 뒤 trigger가 남긴 이력을 읽고, 설치한 table과
//! PostgreSQL trigger function을 지운다. database는 시작한 상태로 끝난다.

#[path = "common/audit_rows.rs"]
mod audit_rows;

use audit_rows::{changed_item, code, drop_tables, history, new_item, Item, SCHEMA};
use orm::db::Pool;
use orm::{Db, Model, Param};
use std::time::{Duration, Instant};

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
    let started = Instant::now();
    println!("RUN audit_history");
    if tokio::time::timeout(DEADLINE, audit_history()).await.is_err() {
        panic!("audit_history: not finished within {DEADLINE:?}");
    }
    println!("PASS audit_history {:?}", started.elapsed());
}
