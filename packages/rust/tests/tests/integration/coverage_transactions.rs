//! transactions: a failed transaction is rolled back and its error reaches the caller, and a failed nested
//! transaction rolls back only to its savepoint. It writes only to composite_account and deletes the rows it wrote.
use super::coverage_env::{code, connect, run};
use super::model::CompositeAccount;

const TENANT: i64 = 990003;

fn failure(message: &str) -> polyspec_orm::Error {
    polyspec_orm::Error::Config(message.into())
}

fn is_failure(r: &polyspec_orm::Result<()>, message: &str) -> bool {
    matches!(r, Err(polyspec_orm::Error::Config(m)) if m == message)
}

#[tokio::test]
// Requirements: DSL-118, INT-45, PLN-13, PLN-20.
async fn coverage_transaction_rollback() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("transaction_rollback", async {
        let db = connect().await;
        assert_eq!(CompositeAccount::new().connect(&db).tenant_id(TENANT).get_count().await.unwrap(), 0, "a row of tenant {TENANT} already exists");
        let r: polyspec_orm::Result<()> = db
            .transaction(async || {
                CompositeAccount::new().set_tenant_id(TENANT).set_account_id(1).set_name("rolled").create().await?;
                Err(failure("coverage rollback"))
            })
            .await;
        assert!(is_failure(&r, "coverage rollback"), "the callback error must reach the caller: {r:?}");
        assert!(CompositeAccount::new().connect(&db).get_by_tenant_id_and_account_id(TENANT, 1).await.unwrap().is_none(), "rolled back row");
        db.close().await;
    })
    .await;
}

#[tokio::test]
// Requirements: DSL-119, INT-40, INT-41, INT-42, INT-43, INT-45, INT-46, INT-47, INT-48, PLN-17.
async fn coverage_transaction_savepoint() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("transaction_savepoint", async {
        let db = connect().await;
        assert_eq!(CompositeAccount::new().connect(&db).tenant_id(TENANT).get_count().await.unwrap(), 0, "a row of tenant {TENANT} already exists");
        let inner_result = std::cell::Cell::new(None);
        let r: polyspec_orm::Result<()> = db
            .transaction(async || {
                CompositeAccount::new().set_tenant_id(TENANT).set_account_id(2).set_name("outer").create().await?;
                let inner: polyspec_orm::Result<()> = db
                    .transaction(async || {
                        CompositeAccount::new().set_tenant_id(TENANT).set_account_id(3).set_name("inner").create().await?;
                        Err(failure("coverage savepoint"))
                    })
                    .await;
                inner_result.set(Some(inner));
                Ok(())
            })
            .await;
        r.unwrap();
        let inner = inner_result.take().expect("the nested transaction ran");
        assert!(is_failure(&inner, "coverage savepoint"), "the nested callback error must reach the outer callback: {inner:?}");
        let account = || CompositeAccount::new().connect(&db);
        assert_eq!(account().get_by_tenant_id_and_account_id(TENANT, 2).await.unwrap().expect("a row").get_name().unwrap(), "outer", "committed outer row");
        assert!(account().get_by_tenant_id_and_account_id(TENANT, 3).await.unwrap().is_none(), "rolled back nested row");
        account().get_by_tenant_id_and_account_id(TENANT, 2).await.unwrap().expect("a row").delete(false).await.unwrap();
        assert_eq!(account().tenant_id(TENANT).get_count().await.unwrap(), 0, "rows left");

        let flow: polyspec_orm::Result<()> = db
            .transaction(async || {
                let spawned = tokio::spawn(async { CompositeAccount::new().get_count().await.map_err(|error| error.code().to_owned()) }).await.unwrap();
                assert_eq!(spawned.err().as_deref(), Some("CONFIG"), "a spawned task inherited the transaction");
                Ok(())
            })
            .retry(0)
            .await;
        flow.unwrap();

        for isolation in [
            polyspec_orm::Isolation::ReadUncommitted,
            polyspec_orm::Isolation::ReadCommitted,
            polyspec_orm::Isolation::RepeatableRead,
            polyspec_orm::Isolation::Serializable,
        ] {
            db.transaction(async || Ok(())).isolation(isolation).retry(0).await.unwrap();
        }
        let read_only: polyspec_orm::Result<()> = db
            .transaction(async || {
                CompositeAccount::new().set_tenant_id(TENANT).set_account_id(4).set_name("read only").create().await?;
                Ok(())
            })
            .read_only()
            .retry(0)
            .await;
        assert_eq!(code(read_only), "READ_ONLY", "read-only write error");
        assert!(account().get_by_tenant_id_and_account_id(TENANT, 4).await.unwrap().is_none(), "read-only transaction wrote a row");

        let timeout_calls = std::cell::Cell::new(0);
        let timeout: polyspec_orm::Result<()> = db
            .transaction(async || {
                timeout_calls.set(timeout_calls.get() + 1);
                Ok(())
            })
            .timeout_ms(500)
            .retry(0)
            .await;
        if db.driver() == "postgres" {
            assert!(timeout.is_ok(), "PostgreSQL supports transaction timeoutMs: {timeout:?}");
            assert_eq!(timeout_calls.get(), 1, "PostgreSQL timeout callback ran");
        } else {
            assert_eq!(code(timeout), "CAPABILITY_UNSUPPORTED", "{} timeoutMs", db.driver());
            assert_eq!(timeout_calls.get(), 0, "unsupported timeout fails before the callback");
        }

        if db.driver() == "postgres" {
            account().set_tenant_id(TENANT).set_account_id(6).set_name("before timeout").create().await.unwrap();
            let holder = connect().await;
            let locked = std::sync::Arc::new(tokio::sync::Notify::new());
            let release = std::sync::Arc::new(tokio::sync::Notify::new());
            let holder_locked = locked.clone();
            let holder_release = release.clone();
            let holder_task = std::thread::spawn(move || {
                tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async move {
                    holder
                        .transaction(async || {
                            CompositeAccount::new().connect(&holder).tenant_id(TENANT).for_update().get().await?;
                            holder_locked.notify_one();
                            holder_release.notified().await;
                            Ok(())
                        })
                        .retry(0)
                        .await
                })
            });
            locked.notified().await;
            let timed: polyspec_orm::Result<()> = db
                .transaction(async || {
                    account().tenant_id(TENANT).set_name("timed out").update(false).await?;
                    Ok(())
                })
                .timeout_ms(250)
                .retry(0)
                .await;
            release.notify_one();
            holder_task.join().unwrap().unwrap();
            assert_eq!(code(timed), "CANCELED", "locked statement timeout");
            let timed_row = account().get_by_tenant_id_and_account_id(TENANT, 6).await.unwrap().expect("timeout probe row");
            assert_eq!(timed_row.get_name().unwrap(), "before timeout", "timed out update rolled back");
            timed_row.delete(false).await.unwrap();
        }

        let attempts = std::cell::Cell::new(0);
        let retried: polyspec_orm::Result<()> = db
            .transaction(async || {
                attempts.set(attempts.get() + 1);
                CompositeAccount::new().set_tenant_id(TENANT).set_account_id(5).set_name(format!("attempt-{}", attempts.get())).create().await?;
                if attempts.get() < 3 {
                    return Err(polyspec_orm::transaction_conflict("coverage retry"));
                }
                Ok(())
            })
            .isolation(polyspec_orm::Isolation::ReadCommitted)
            .retry(3)
            .await;
        assert!(retried.is_ok() && attempts.get() == 3, "retry attempts = {}, result = {retried:?}", attempts.get());
        let final_attempt = account().get_by_tenant_id_and_account_id(TENANT, 5).await.unwrap().expect("final retry row");
        assert_eq!(final_attempt.get_name().unwrap(), "attempt-3", "the final callback attempt committed");
        final_attempt.delete(false).await.unwrap();
        attempts.set(0);
        let default_retry: polyspec_orm::Result<()> = db
            .transaction(async || {
                attempts.set(attempts.get() + 1);
                if attempts.get() < 3 {
                    return Err(polyspec_orm::transaction_conflict("default coverage retry"));
                }
                Ok(())
            })
            .await;
        assert!(default_retry.is_ok() && attempts.get() == 3, "default retry attempts = {}, result = {default_retry:?}", attempts.get());
        attempts.set(0);
        let no_retry: polyspec_orm::Result<()> = db
            .transaction(async || {
                attempts.set(attempts.get() + 1);
                Err(polyspec_orm::transaction_conflict("coverage retry disabled"))
            })
            .retry(0)
            .await;
        assert_eq!(code(no_retry), "DEADLOCK", "retry=0 returns the deadlock");
        assert_eq!(attempts.get(), 1, "retry=0 invokes the callback once");
        db.close().await;
    })
    .await;
}
