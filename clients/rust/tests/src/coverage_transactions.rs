//! transactions: 실패한 transaction은 rollback되고 그 오류가 호출자에게 가며, 실패한 nested
//! transaction은 savepoint까지만 rollback된다. composite_account에만 쓰고 쓴 row를 지운다.
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
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_transaction_rollback() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
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
        assert_eq!(
            code(CompositeAccount::new().connect(&db).get_by_tenant_id_and_account_id(TENANT, 1).await),
            polyspec_orm::codes::NO_ROWS,
            "rolled back row"
        );
        db.close().await;
    })
    .await;
}

#[tokio::test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_transaction_savepoint() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
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
        assert_eq!(account().get_by_tenant_id_and_account_id(TENANT, 2).await.unwrap().get_name().unwrap(), "outer", "committed outer row");
        assert_eq!(code(account().get_by_tenant_id_and_account_id(TENANT, 3).await), polyspec_orm::codes::NO_ROWS, "rolled back nested row");
        account().get_by_tenant_id_and_account_id(TENANT, 2).await.unwrap().delete(false).await.unwrap();
        assert_eq!(account().tenant_id(TENANT).get_count().await.unwrap(), 0, "rows left");
        db.close().await;
    })
    .await;
}
