//! model_writes: runs create, creates, update, duplication,
//! create, and delete on the generated CompositeAccount model against composite_account, which has no identity column, and deletes all the rows it wrote.
use super::coverage_env::{code, connect, run};
use super::model::CompositeAccount;
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
// Requirements: DSL-56, DSL-57, DSL-58, DSL-60, DSL-103, DSL-104, DSL-105, DSL-106, DSL-110.
async fn coverage_model_write_cycle() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("model_write_cycle", async {
        let db = connect().await;
        let account = || CompositeAccount::new().connect(&db);
        assert_eq!(account().tenant_id(TENANT).get_count().await.unwrap(), 0, "a composite_account row of tenant {TENANT} already exists");
        let created = account().set_tenant_id(TENANT).set_account_id(1).set_name("created").create().await.unwrap();
        assert_eq!(created.get_name().unwrap(), "created", "created row");
        let many = vec![
            CompositeAccount::new().set_tenant_id(TENANT).set_account_id(2).set_name("many-2"),
            CompositeAccount::new().set_tenant_id(TENANT).set_account_id(3).set_name("many-3"),
            CompositeAccount::new().set_tenant_id(TENANT).set_account_id(4).set_name("many-4"),
        ];
        assert_eq!(account().creates(many, 3).await.unwrap(), 3, "creates");
        let mut row = account().get_by_tenant_id_and_account_id(TENANT, 1).await.unwrap().expect("a row").set_name("updated");
        row.update(false).await.unwrap();
        assert_eq!(account().get_by_tenant_id_and_account_id(TENANT, 1).await.unwrap().expect("a row").get_name().unwrap(), "updated", "update");
        account().set_tenant_id(TENANT).set_account_id(1).set_name("ignored").duplication(CompositeAccount::new().set_name("upserted")).create().await.unwrap();
        assert_eq!(account().get_by_tenant_id_and_account_id(TENANT, 1).await.unwrap().expect("a row").get_name().unwrap(), "upserted", "duplication");
        assert_eq!(account().tenant_id(TENANT).get_count().await.unwrap(), 4, "rows of tenant {TENANT}");
        let rows = account().tenant_id(TENANT).gets().await.unwrap();
        assert_eq!(rows.len(), 4, "rows to delete");
        rows.delete(false).await.unwrap();
        assert!(account().get_by_tenant_id_and_account_id(TENANT, 1).await.unwrap().is_none(), "deleted row");
        assert_eq!(account().tenant_id(TENANT).get_count().await.unwrap(), 0, "rows left");
        db.close().await;
    })
    .await;
}

#[tokio::test]
// Requirements: PLN-26.
async fn coverage_model_write_arithmetic_attributes() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("model_write_arithmetic_attributes", async {
        let db = connect().await;
        let events = Arc::new(Mutex::new(Vec::<Vec<polyspec_orm::Param>>::new()));
        let sink = events.clone();
        let subscription = db
            .subscribe(move |event: &polyspec_orm::StatementEvent<'_>| {
                if event.kind == polyspec_orm::events::KIND_UPDATE && event.tables.iter().any(|table| table == "composite_account") {
                    sink.lock().unwrap().push(event.binds.to_vec());
                }
                Ok(())
            })
            .unwrap();
        let tenant = 1_000_000_000_000 + i64::from(std::process::id());
        let account = || CompositeAccount::new().connect(&db);
        let existing = account().tenant_id(tenant).get_count().await.unwrap();
        assert_eq!(existing, 0, "scratch tenant starts empty");
        account().set_tenant_id(tenant).set_account_id(1).set_name("arithmetic").create().await.unwrap();
        let outcome: Result<(), String> = async {
            let mut loaded = account()
                .get_by_tenant_id_and_account_id(tenant, 1)
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "created row is unreadable".to_owned())?;
            loaded = loaded.plus_account_id(7);
            loaded.update(false).await.map_err(|error| error.to_string())?;
            let after_plus = account()
                .get_by_tenant_id_and_account_id(tenant, 8)
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "row disappeared after plus".to_owned())?;
            if after_plus.get_name().map_err(|error| error.to_string())? != "arithmetic" {
                return Err("plus amount did not update the account key".into());
            }
            if !events.lock().unwrap().iter().any(|binds| binds.contains(&polyspec_orm::Param::I64(7))) {
                return Err("plus amount 7 is absent from update binds".into());
            }
            loaded.update(false).await.map_err(|error| error.to_string())?;
            if events.lock().unwrap().len() != 1 {
                return Err(format!("updates after repeating a completed write = {}, want 1", events.lock().unwrap().len()));
            }

            let mut current = account()
                .get_by_tenant_id_and_account_id(tenant, 8)
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "row disappeared before minus".to_owned())?;
            let amount = current.get_account_id().map_err(|error| error.to_string())? + 1;
            current = current.minus_account_id(amount);
            current.update(false).await.map_err(|error| error.to_string())?;
            let after_minus = account()
                .get_by_tenant_id_and_account_id(tenant, 0)
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "row disappeared after minus".to_owned())?;
            if after_minus.get_name().map_err(|error| error.to_string())? != "arithmetic" {
                return Err(format!("minus amount {amount} did not clamp the account key at zero"));
            }
            if !events.lock().unwrap().iter().any(|binds| binds.contains(&polyspec_orm::Param::I64(i64::from(amount)))) {
                return Err(format!("minus amount {amount} is absent from update binds"));
            }
            Ok(())
        }
        .await;
        let cleanup = match account().tenant_id(tenant).gets().await {
            Ok(rows) => rows.delete(false).await,
            Err(error) => Err(error),
        };
        subscription.unsubscribe();
        let remaining = account().tenant_id(tenant).get_count().await;
        db.close().await;
        if let Err(error) = cleanup {
            panic!("delete scratch tenant {tenant}: {error}");
        }
        if !matches!(remaining, Ok(0)) {
            panic!("scratch tenant {tenant} remains after delete");
        }
        if let Err(error) = outcome {
            panic!("{error}");
        }
    })
    .await;
}
