//! composite_keys: 두 key 구성 요소로 row를 찾고, account의 memberships relation을 읽고,
//! account를 지우면 ON DELETE CASCADE가 membership을 지운다. 쓴 row를 모두 지운다.
use super::coverage_env::{connect, run};
use super::model::{CompositeAccount, CompositeMembership};

const TENANT: i64 = 990004;

#[tokio::test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_composite_key_rows() {
    run("composite_key_rows", async {
        let db = connect().await;
        let account = || CompositeAccount::new().connect(&db);
        let membership = || CompositeMembership::new().connect(&db);
        assert_eq!(account().tenant_id(TENANT).get_count().await.unwrap(), 0, "an account of tenant {TENANT} already exists");
        assert_eq!(membership().tenant_id(TENANT).get_count().await.unwrap(), 0, "a membership of tenant {TENANT} already exists");
        account().set_tenant_id(TENANT).set_account_id(1).set_name("a").create().await.unwrap();
        account().set_tenant_id(TENANT).set_account_id(2).set_name("b").create().await.unwrap();
        membership().set_tenant_id(TENANT).set_account_id(2).set_role("owner").create().await.unwrap();
        assert_eq!(account().get_by_tenant_id_and_account_id(TENANT, 2).await.unwrap().get_name().unwrap(), "b", "row by both key components");
        // relation은 한 column으로 match한다. tenant의 membership은 account 2의 것 하나뿐이다.
        let loaded = account()
            .relations(CompositeMembership::new().match_tenant_id_with_tenant_id().alias_memberships())
            .get_by_tenant_id_and_account_id(TENANT, 2)
            .await
            .unwrap();
        let memberships = loaded.get_memberships().expect("the memberships relation");
        let roles: Vec<(i64, &str)> = memberships.models().map(|m| (m.get_account_id().unwrap(), m.get_role().unwrap())).collect();
        assert_eq!(roles, [(2, "owner")], "memberships of account ({TENANT}, 2)");
        account().get_by_tenant_id_and_account_id(TENANT, 2).await.unwrap().delete(false).await.unwrap();
        assert_eq!(membership().tenant_id(TENANT).get_count().await.unwrap(), 0, "ON DELETE CASCADE membership");
        account().get_by_tenant_id_and_account_id(TENANT, 1).await.unwrap().delete(false).await.unwrap();
        assert_eq!(account().tenant_id(TENANT).get_count().await.unwrap(), 0, "accounts left");
        assert_eq!(membership().tenant_id(TENANT).get_count().await.unwrap(), 0, "memberships left");
        db.close().await;
    })
    .await;
}
