//! audit operation id (docs/dbspec.md, "Audit"): executor는 transaction의 operation id를
//! insert하거나 update하는 모든 감사 대상 row의 operation column에 쓰고, render된 trigger는
//! 각 version을 이력 table에 복사한다. SQLite, MySQL, PostgreSQL에서 실행하며
//! ORM_TEST_MYSQL_DSN이나 ORM_TEST_POSTGRES_DSN이 없으면 실패한다.

#[path = "common/audit_rows.rs"]
mod audit_rows;

use audit_rows::{changed_item, code, drop_tables, history, new_item, SCHEMA};
use orm::{Db, Model, Param};

/// Returns the DSN in `var`; an unset or empty variable fails the test.
fn require_dsn(var: &str) -> String {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; database tests never skip"),
    }
}

#[tokio::test]
async fn audit_operation_id() {
    let started = std::time::Instant::now();
    println!("RUN audit_operation_id");
    let tmp = std::env::temp_dir().join(format!("orm-rust-audit-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let targets = vec![
        ("sqlite", format!("sqlite://{}", tmp.join("audit.sqlite").display())),
        ("mysql", require_dsn("ORM_TEST_MYSQL_DSN")),
        ("postgres", require_dsn("ORM_TEST_POSTGRES_DSN")),
    ];
    for (driver, dsn) in &targets {
        let db = Db::connect(dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
        drop_tables(&db, driver).await;
        db.utils().schema().install(&SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
        db.utils().schema().install(&SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install again: {e}"));

        // operation id가 없는 audit 대상 insert는 database에 닿기 전에 CONFIG로 실패한다.
        let mut outside = new_item("a");
        outside.core_mut().connect(&db);
        assert_eq!(code(orm::model::create(&mut outside).await), orm::codes::CONFIG, "{driver}: insert outside a transaction");
        let without = db.transaction(async || orm::model::create(&mut new_item("a")).await.map(|_| ())).await;
        assert_eq!(code(without), orm::codes::CONFIG, "{driver}: insert without an operation id");
        let uuid = "0f0e0d0c-0b0a-4908-8706-050403020100";
        let wrong = db.transaction(async || orm::model::create(&mut new_item("a")).await.map(|_| ())).operation(uuid).await;
        assert_eq!(code(wrong), orm::codes::CONFIG, "{driver}: a uuid operation id for an i64 operation column");
        let explicit = db
            .transaction(async || {
                let mut row = new_item("a");
                row.core_mut().set("operation_id", Param::I64(5));
                orm::model::create(&mut row).await.map(|_| ())
            })
            .operation(5)
            .await;
        assert_eq!(code(explicit), orm::codes::IR_INVALID, "{driver}: an assigned operation column");
        let nested = db.transaction(async || db.transaction(async || Ok(())).operation(6).await).operation(5).await;
        assert_eq!(code(nested), orm::codes::CONFIG, "{driver}: a nested operation id");
        assert!(history(&db).await.is_empty(), "{driver}: a rejected write records no history");

        let seq = db
            .transaction(async || {
                let created = orm::model::create(&mut new_item("a")).await?;
                created.value("seq").expect("generated seq").as_i64()
            })
            .operation(7)
            .await
            .unwrap_or_else(|e| panic!("{driver}: insert: {e}"));
        db.transaction(async || orm::model::update(&mut changed_item(seq, "b"), false).await)
            .operation(8)
            .await
            .unwrap_or_else(|e| panic!("{driver}: update: {e}"));
        db.transaction(async || orm::model::delete(&changed_item(seq, "b"), false).await)
            .operation(9)
            .await
            .unwrap_or_else(|e| panic!("{driver}: delete: {e}"));

        let rows = history(&db).await;
        let summary: Vec<(String, Option<i64>, i64, i64, String, bool)> = rows
            .iter()
            .map(|r| {
                let previous = if r["previous_operation_id"].is_null() { None } else { Some(r["previous_operation_id"].as_i64().unwrap()) };
                let text = |column: &str| r[column].as_string().unwrap();
                (text("change"), previous, r["operation_id"].as_i64().unwrap(), r["seq"].as_i64().unwrap(), text("title"), r["deleted_at"].is_null())
            })
            .collect();
        assert_eq!(
            summary,
            [
                ("insert".to_owned(), None, 7, seq, "a".to_owned(), true),
                ("update".to_owned(), Some(7), 8, seq, "b".to_owned(), true),
                ("update".to_owned(), Some(8), 9, seq, "b".to_owned(), false),
            ],
            "{driver}: history rows"
        );
        drop_tables(&db, driver).await;
        db.close().await;
        println!("PASS audit_operation_id {driver}");
    }
    let _ = std::fs::remove_dir_all(&tmp);
    println!("PASS audit_operation_id {:?}", started.elapsed());
}
