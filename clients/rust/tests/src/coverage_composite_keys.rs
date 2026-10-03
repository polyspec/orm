//! composite_keys: 두 key 구성 요소로 row를 찾고, foreign key의 두 성분(tenant_id,
//! account_id)으로 잇는 account의 memberships relation을 읽고, account를 지우면
//! ON DELETE CASCADE가 membership을 지운다. 쓴 row를 모두 지운다.
use super::coverage_env::{connect, run};
use super::model::{CompositeAccount, CompositeMembership};

const TENANT: i64 = 990004;
/// 다른 tenant에도 account 2가 있어야 account_id 한 성분만으로 잇는 relation이 드러난다.
const OTHER_TENANT: i64 = 990006;

#[tokio::test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_composite_key_rows() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    run("composite_key_rows", async {
        let db = connect().await;
        let account = || CompositeAccount::new().connect(&db);
        let membership = || CompositeMembership::new().connect(&db);
        for tenant in [TENANT, OTHER_TENANT] {
            assert_eq!(account().tenant_id(tenant).get_count().await.unwrap(), 0, "an account of tenant {tenant} already exists");
            assert_eq!(membership().tenant_id(tenant).get_count().await.unwrap(), 0, "a membership of tenant {tenant} already exists");
        }
        account().set_tenant_id(TENANT).set_account_id(1).set_name("a").create().await.unwrap();
        account().set_tenant_id(TENANT).set_account_id(2).set_name("b").create().await.unwrap();
        account().set_tenant_id(OTHER_TENANT).set_account_id(2).set_name("c").create().await.unwrap();
        membership().set_tenant_id(TENANT).set_account_id(1).set_role("member").create().await.unwrap();
        membership().set_tenant_id(TENANT).set_account_id(2).set_role("owner").create().await.unwrap();
        membership().set_tenant_id(OTHER_TENANT).set_account_id(2).set_role("guest").create().await.unwrap();
        let by_key = account().get_by_tenant_id_and_account_id(TENANT, 2).await.unwrap().get_name().unwrap().to_owned();
        // relation은 foreign key의 두 성분을 key 순서대로 잇는다. 자식이 자기 연결을 가지면 부모 row를
        // 읽은 뒤 따로 읽는다. 두 경로의 결과를 모은 뒤 row를 지우고 나서 비교한다.
        let same = account()
            .tenant_id(TENANT)
            .relations(CompositeMembership::new().match_tenant_id_with_tenant_id().match_account_id_with_account_id().alias_memberships())
            .gets()
            .await
            .unwrap();
        let own = account()
            .tenant_id(TENANT)
            .relations(CompositeMembership::new().connect(&db).match_tenant_id_with_tenant_id().match_account_id_with_account_id().alias_memberships())
            .gets()
            .await
            .unwrap();
        let mut results = Vec::new();
        for (path, loaded) in [("same statement", same), ("own connection", own)] {
            let mut got = Vec::new();
            for a in loaded.models() {
                for m in a.get_memberships().unwrap().expect("the memberships relation").models() {
                    got.push(format!(
                        "{}/{}:{}/{}/{}",
                        a.get_tenant_id().unwrap(),
                        a.get_account_id().unwrap(),
                        m.get_tenant_id().unwrap(),
                        m.get_account_id().unwrap(),
                        m.get_role().unwrap()
                    ));
                }
            }
            results.push((path, got));
        }
        account().get_by_tenant_id_and_account_id(TENANT, 2).await.unwrap().delete(false).await.unwrap();
        let after_cascade = membership().tenant_id(TENANT).get_count().await.unwrap();
        for tenant in [TENANT, OTHER_TENANT] {
            account().tenant_id(tenant).gets().await.unwrap().delete(false).await.unwrap();
        }
        assert_eq!(by_key, "b", "row by both key components");
        for (path, got) in results {
            assert_eq!(
                got,
                [format!("{TENANT}/1:{TENANT}/1/member"), format!("{TENANT}/2:{TENANT}/2/owner")],
                "{path}: memberships of tenant {TENANT} accounts"
            );
        }
        assert_eq!(after_cascade, 1, "ON DELETE CASCADE removed the membership of account 2");
        for tenant in [TENANT, OTHER_TENANT] {
            assert_eq!(account().tenant_id(tenant).get_count().await.unwrap(), 0, "accounts of tenant {tenant} left");
            assert_eq!(membership().tenant_id(tenant).get_count().await.unwrap(), 0, "memberships of tenant {tenant} left");
        }
        db.close().await;
    })
    .await;
}
