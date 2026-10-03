//! audit operation id (docs/dbspec.md, "Audit"): executor는 transaction의 operation id를
//! insert하거나 update하는 모든 감사 대상 row의 operation column에 쓰고, render된 trigger는
//! 각 version을 이력 table에 복사한다. SQLite, MySQL, PostgreSQL에서 database마다 자기만의
//! case database(orm-case-database)로 실행하며 ORM_TEST_MYSQL_DSN이나 ORM_TEST_POSTGRES_DSN이
//! 없으면 실패한다.

#[path = "common/audit_rows.rs"]
mod audit_rows;

use audit_rows::{changed_item, code, history, new_item, SCHEMA};
use orm::{Db, Model, Param, TransactionOnceError};
use orm_case_database::CaseDatabase;

#[tokio::test]
async fn audit_operation_id() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        let db = Db::connect(database.dsn(), 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
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
        // 모든 transaction 진입점이 operation id를 받는다: transaction_send와, callback을 한 번만 실행하고
        // 그 오류 type을 지키는 transaction_once도 operation(id)를 받는다.
        db.transaction_send(|| async { orm::model::update(&mut changed_item(seq, "c"), false).await })
            .operation(9)
            .await
            .unwrap_or_else(|e| panic!("{driver}: transaction_send update: {e}"));
        db.transaction_once(async || orm::model::update(&mut changed_item(seq, "d"), false).await)
            .operation(10)
            .await
            .unwrap_or_else(|e| panic!("{driver}: transaction_once update: {e}"));
        let once_without = db.transaction_once(async || orm::model::update(&mut changed_item(seq, "e"), false).await).await;
        assert!(
            matches!(&once_without, Err(TransactionOnceError::Callback(e)) if e.code() == orm::codes::CONFIG),
            "{driver}: transaction_once without an operation id: {once_without:?}"
        );
        let nested_once = db
            .transaction(async || match db.transaction_once(async || Ok::<(), orm::Error>(())).operation(12).await {
                Err(TransactionOnceError::Orm(e)) => Err::<(), orm::Error>(e),
                other => panic!("{driver}: nested transaction_once with an operation id: {other:?}"),
            })
            .operation(11)
            .await;
        assert_eq!(code(nested_once), orm::codes::CONFIG, "{driver}: a nested transaction_once operation id");
        db.transaction(async || orm::model::delete(&changed_item(seq, "d"), false).await)
            .operation(13)
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
                ("update".to_owned(), Some(8), 9, seq, "c".to_owned(), true),
                ("update".to_owned(), Some(9), 10, seq, "d".to_owned(), true),
                ("update".to_owned(), Some(10), 13, seq, "d".to_owned(), false),
            ],
            "{driver}: history rows"
        );
        db.close().await;
        database.drop().await;
        orm_testcase::step(format_args!("audit_operation_id {driver}"));
    }
}

/// 실행 중인 transaction 안에서 utils().set_operation(id)로 operation id를 정한다(audit_rows::set_operation_case).
#[tokio::test]
async fn set_operation_in_transaction() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        let db = Db::connect(database.dsn(), 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
        db.utils().schema().install(&SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
        audit_rows::set_operation_case(&db, driver).await;
        db.close().await;
        database.drop().await;
        orm_testcase::step(format_args!("set_operation_in_transaction {driver}"));
    }
}
