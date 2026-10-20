//! model_writes: runs create, creates, update, duplication,
//! create, and delete on the generated CompositeAccount model against composite_account, which has no identity column, and deletes all the rows it wrote.
use super::coverage_env::{connect, run};
use super::model::CompositeAccount;

const TENANT: i64 = 990002;

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
