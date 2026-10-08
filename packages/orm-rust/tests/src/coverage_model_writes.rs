//! model_writes: 생성된 CompositeAccount model의 create, creates, update, duplication
//! create, delete를 identity column이 없는 composite_account에서 실행하고 쓴 row를 모두 지운다.
use super::coverage_env::{code, connect, run};
use super::model::CompositeAccount;

const TENANT: i64 = 990002;

#[tokio::test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
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
        assert_eq!(account().creates(many).await.unwrap(), 3, "creates");
        let mut row = account().get_by_tenant_id_and_account_id(TENANT, 1).await.unwrap().set_name("updated");
        row.update(false).await.unwrap();
        assert_eq!(account().get_by_tenant_id_and_account_id(TENANT, 1).await.unwrap().get_name().unwrap(), "updated", "update");
        account().set_tenant_id(TENANT).set_account_id(1).set_name("ignored").duplication(CompositeAccount::new().set_name("upserted")).create().await.unwrap();
        assert_eq!(account().get_by_tenant_id_and_account_id(TENANT, 1).await.unwrap().get_name().unwrap(), "upserted", "duplication");
        assert_eq!(account().tenant_id(TENANT).get_count().await.unwrap(), 4, "rows of tenant {TENANT}");
        let rows = account().tenant_id(TENANT).gets().await.unwrap();
        assert_eq!(rows.len(), 4, "rows to delete");
        rows.delete(false).await.unwrap();
        assert_eq!(code(account().get_by_tenant_id_and_account_id(TENANT, 1).await), polyspec_orm::codes::NO_ROWS, "deleted row");
        assert_eq!(account().tenant_id(TENANT).get_count().await.unwrap(), 0, "rows left");
        db.close().await;
    })
    .await;
}
