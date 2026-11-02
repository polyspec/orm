//! model_writes: create_parts runs the batch behaviour of CompositeAccount natively, and model_write_cycle checks
//! the ordered JSON text and the codec columns, which the model_writes recipe does not assert.
use super::coverage_env::{code, connect, run};
use super::model::{Author, CompositeAccount};
use std::sync::{Arc, Mutex};

const TENANT: i64 = 990002;

#[tokio::test]
// Requirements: DSL-104, INT-35, PRT-41.
async fn coverage_model_create_parts() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("create_parts", async {
        let db = connect().await;
        let tenant = TENANT + 1;
        let account = || CompositeAccount::new().connect(&db);
        assert_eq!(account().tenant_id(tenant).get_count().await.unwrap(), 0, "tenant starts empty");
        let events = Arc::new(Mutex::new(Vec::<(usize, bool)>::new()));
        let sink = events.clone();
        let subscription = db
            .subscribe(move |event: &polyspec_orm::StatementEvent<'_>| {
                if event.kind == polyspec_orm::events::KIND_INSERT && event.tables.iter().any(|table| table == "composite_account") {
                    sink.lock().unwrap().push((event.binds.len() / 3, event.error.is_some()));
                }
                Ok(())
            })
            .unwrap();

        let refused = vec![CompositeAccount::new().set_tenant_id(tenant).set_account_id(1).set_name("refused")];
        assert_eq!(code(account().creates(refused, 0).await), "CONFIG", "batch zero error");
        assert!(events.lock().unwrap().is_empty(), "refused batch sends no insert");
        let limit = if db.driver() == "sqlite" { 999 } else { 65535 };
        let oversized = (0..limit / 3 + 1).map(|_| CompositeAccount::new().set_tenant_id(tenant).set_account_id(8).set_name("oversized")).collect();
        assert_eq!(code(account().creates(oversized, limit / 3 + 1).await), "BATCH_TOO_LARGE", "over-limit batch is refused");
        assert!(events.lock().unwrap().is_empty(), "over-limit batch sends no insert");

        let labels = ["ordered-5", "ordered-4", "ordered-3", "ordered-2", "ordered-1"];
        let rows =
            labels.iter().enumerate().map(|(i, label)| CompositeAccount::new().set_tenant_id(tenant).set_account_id(i as i64 + 1).set_name(*label)).collect();
        assert_eq!(account().creates(rows, 2).await.unwrap(), 5, "creates inserts all rows");
        assert_eq!(*events.lock().unwrap(), [(2, false), (2, false), (1, false)], "INSERT batches are 2, 2, 1");
        let stored = account().tenant_id(tenant).order_by_account_id_asc().gets().await.unwrap();
        assert_eq!(stored.iter().map(|(_, row)| row.get_name().unwrap().to_owned()).collect::<Vec<_>>(), labels, "stored row order");
        stored.delete(false).await.unwrap();
        events.lock().unwrap().clear();

        account().set_tenant_id(tenant).set_account_id(99).set_name("existing").create().await.unwrap();
        events.lock().unwrap().clear();
        let failing = [10, 11, 12, 13, 99]
            .into_iter()
            .map(|id| CompositeAccount::new().set_tenant_id(tenant).set_account_id(id).set_name(format!("rollback-{id}")))
            .collect();
        assert_eq!(code(account().creates(failing, 2).await), "DUPLICATE_KEY", "third batch conflict");
        assert_eq!(*events.lock().unwrap(), [(2, false), (2, false), (1, true)], "failure is in the third batch");
        assert_eq!(account().tenant_id(tenant).get_count().await.unwrap(), 1, "failed call rolls back earlier batches");
        assert_eq!(account().get_by_tenant_id_and_account_id(tenant, 99).await.unwrap().unwrap().get_name().unwrap(), "existing");
        subscription.unsubscribe();
        account().tenant_id(tenant).gets().await.unwrap().delete(false).await.unwrap();
        assert_eq!(account().tenant_id(tenant).get_count().await.unwrap(), 0, "case leaves no rows");
        db.close().await;
    })
    .await;
}

#[tokio::test]
// Requirements: COD-11, COD-12, COD-15, COD-38, DIA-26.
async fn coverage_model_write_cycle() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("model_write_cycle", async {
        let db = connect().await;
        let text = r#"{"b":1,"a":[],"c":{},"n":1.50}"#;
        let rollback: polyspec_orm::Result<()> = db
            .transaction(async || {
                let row = Author::new().connect(&db).add_all_columns().get_by_seq(1).await?.expect("seed author row 1");
                let mut row = row.set_json_setting(polyspec_orm::StyledValue::Value(polyspec_orm::ordered_json::parse(text).unwrap()))?;
                row.update(false).await?;
                let stored = Author::new().connect(&db).add_all_columns().get_by_seq(1).await?.expect("author row remains after update");
                match stored.get_json_setting()? {
                    polyspec_orm::StyledValue::Value(value) => assert_eq!(value.compact(), text, "ordered JSON text round trip"),
                    polyspec_orm::StyledValue::SqlNull => panic!("ordered JSON text read back as SQL NULL"),
                }
                Err(polyspec_orm::Error::Config("rollback ordered JSON text probe".into()))
            })
            .retry(0)
            .await;
        assert!(matches!(rollback, Err(polyspec_orm::Error::Config(message)) if message == "rollback ordered JSON text probe"));

        let codec_rollback: polyspec_orm::Result<()> = db
            .transaction(async || {
                let row = Author::new().connect(&db).add_all_columns().get_by_seq(1).await?.expect("seed author row 1 for codec columns");
                let mut row = row
                    .set_ip("10.0.0.1")
                    .set_gz_extend(polyspec_orm::StyledValue::Value(polyspec_orm::serde_json::Value::String("compressed text".into())))?
                    .set_base64_extra(polyspec_orm::StyledValue::Value(polyspec_orm::serde_json::Value::String("plain".into())))?;
                row.update(false).await?;
                let stored = Author::new().connect(&db).add_all_columns().get_by_seq(1).await?.expect("author row remains after codec update");
                assert_eq!(stored.get_ip()?, Some("10.0.0.1"), "ip codec column round trip");
                match stored.get_gz_extend()? {
                    polyspec_orm::StyledValue::Value(value) => assert_eq!(value.as_str(), Some("compressed text"), "gz codec column round trip"),
                    polyspec_orm::StyledValue::SqlNull => panic!("gz codec column read back as SQL NULL"),
                }
                match stored.get_base64_extra()? {
                    polyspec_orm::StyledValue::Value(value) => assert_eq!(value.as_str(), Some("plain"), "base64 codec column round trip"),
                    polyspec_orm::StyledValue::SqlNull => panic!("base64 codec column read back as SQL NULL"),
                }
                assert_eq!(Author::new().connect(&db).ip("10.0.0.1").get_count().await?, 1, "ip codec equality");
                assert_eq!(code(stored.set_ip("10. 0.0.1").update(false).await), "CODEC_ENCODE", "ip rejects embedded whitespace");
                Err(polyspec_orm::Error::Config("rollback codec columns probe".into()))
            })
            .retry(0)
            .await;
        assert!(matches!(codec_rollback, Err(polyspec_orm::Error::Config(message)) if message == "rollback codec columns probe"));
        db.close().await;
    })
    .await;
}
#[tokio::test]
// Requirements: DIA-26, COD-15.
async fn coverage_ordered_json_repeated_member_name() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("ordered_json_repeated_member_name", async {
        let db = connect().await;
        let text = r#"{"a":1,"b":2,"a":3}"#;
        let rollback: polyspec_orm::Result<()> = db
            .transaction(async || {
                let row = Author::new().connect(&db).add_all_columns().get_by_seq(1).await?.expect("seed author row 1 for repeated member names");
                let mut row = row.set_json_setting(polyspec_orm::StyledValue::Value(polyspec_orm::ordered_json::parse(text).unwrap()))?;
                row.update(false).await?;
                let stored = Author::new().connect(&db).add_all_columns().get_by_seq(1).await?.expect("author row remains after repeated member name update");
                match stored.get_json_setting()? {
                    polyspec_orm::StyledValue::Value(value) => assert_eq!(value.raw(), text, "repeated member name text round trip"),
                    polyspec_orm::StyledValue::SqlNull => panic!("repeated member name text read back as SQL NULL"),
                }
                Err(polyspec_orm::Error::Config("rollback repeated member name probe".into()))
            })
            .retry(0)
            .await;
        assert!(matches!(rollback, Err(polyspec_orm::Error::Config(message)) if message == "rollback repeated member name probe"));
        db.close().await;
    })
    .await;
}

