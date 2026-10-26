//! composite_keys: finds a row by two key components, and reads the memberships relation of the account, which joins on the two foreign key components (tenant_id,
//! account_id); deleting the account
//! triggers ON DELETE CASCADE to delete the membership. It deletes all the rows it wrote.
use super::coverage_env::{connect, run};
use super::model::{CompositeAccount, CompositeMembership};
use std::sync::{Arc, Mutex};

const TENANT: i64 = 990004;
/// Account 2 must also exist in another tenant so that the relation joined by the account_id component alone is revealed.
const OTHER_TENANT: i64 = 990006;

fn relation_rows<'a>(accounts: impl Iterator<Item = &'a CompositeAccount>) -> Vec<String> {
    let mut rows = Vec::new();
    for account in accounts {
        for membership in account.get_memberships().unwrap().expect("the memberships relation").models() {
            rows.push(format!(
                "{}/{}:{}/{}/{}",
                account.get_tenant_id().unwrap(),
                account.get_account_id().unwrap(),
                membership.get_tenant_id().unwrap(),
                membership.get_account_id().unwrap(),
                membership.get_role().unwrap()
            ));
        }
    }
    rows
}

#[tokio::test]
async fn coverage_composite_key_rows() {
    // Requirements: INT-87, PRT-12, PRT-40.
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("composite_key_rows", async {
        let fixture_path = polyspec_orm_testcase::manifest_dir().join("../../../contracts/fixtures/composite_key_collision.json");
        let fixture_text = std::fs::read_to_string(fixture_path).expect("composite-key collision fixture");
        let fixture: serde_json::Value = serde_json::from_str(&fixture_text).expect("valid composite-key fixture JSON");
        assert_eq!(fixture["feature"], "composite_keys");
        assert_eq!(fixture["cases"][0]["id"], "composite_key_rows");
        let collision_rows: Vec<(i64, i64, String, String)> = fixture["cases"][0]["expected"]
            .as_array()
            .expect("collision fixture rows")
            .iter()
            .map(|row| {
                (
                    row["tenant_id"].as_i64().expect("collision tenant_id"),
                    row["account_id"].as_i64().expect("collision account_id"),
                    row["name"].as_str().expect("collision name").to_owned(),
                    row["role"].as_str().expect("collision role").to_owned(),
                )
            })
            .collect();
        assert_eq!(collision_rows.len(), 2);
        let collision_tenants = [collision_rows[0].0, collision_rows[1].0];
        let db = connect().await;
        let account = || CompositeAccount::new().connect(&db);
        let membership = || CompositeMembership::new().connect(&db);
        for tenant in [TENANT, OTHER_TENANT, collision_tenants[0], collision_tenants[1]] {
            assert_eq!(account().tenant_id(tenant).get_count().await.unwrap(), 0, "an account of tenant {tenant} already exists");
            assert_eq!(membership().tenant_id(tenant).get_count().await.unwrap(), 0, "a membership of tenant {tenant} already exists");
        }
        account().set_tenant_id(TENANT).set_account_id(1).set_name("a").create().await.unwrap();
        account().set_tenant_id(TENANT).set_account_id(2).set_name("b").create().await.unwrap();
        account().set_tenant_id(TENANT).set_account_id(3).set_name("d").create().await.unwrap();
        account().set_tenant_id(OTHER_TENANT).set_account_id(2).set_name("c").create().await.unwrap();
        membership().set_tenant_id(TENANT).set_account_id(1).set_role("member").create().await.unwrap();
        membership().set_tenant_id(TENANT).set_account_id(2).set_role("owner").create().await.unwrap();
        membership().set_tenant_id(TENANT).set_account_id(3).set_role("editor").create().await.unwrap();
        membership().set_tenant_id(OTHER_TENANT).set_account_id(2).set_role("guest").create().await.unwrap();
        for (tenant, account_id, name, role) in &collision_rows {
            account().set_tenant_id(*tenant).set_account_id(*account_id).set_name(name).create().await.unwrap();
            membership().set_tenant_id(*tenant).set_account_id(*account_id).set_role(role).create().await.unwrap();
        }
        let by_key = account().get_by_tenant_id_and_account_id(TENANT, 2).await.unwrap().expect("a row").get_name().unwrap().to_owned();
        let relation_events = Arc::new(Mutex::new(Vec::<(String, Vec<polyspec_orm::Param>)>::new()));
        let captured = relation_events.clone();
        let subscription = db
            .subscribe(move |event: &polyspec_orm::StatementEvent<'_>| {
                if event.sql.contains("composite_membership") && event.sql.contains(" IN (") {
                    captured.lock().unwrap().push((event.sql.to_owned(), event.binds.to_vec()));
                }
                Ok(())
            })
            .unwrap();
        // The relation joins the two foreign key components in key order. When a child has its own link, the parent row is read
        // separately after it is read. The results of both paths are collected, the rows are deleted, and then they are compared.
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
            results.push((path, relation_rows(loaded.models())));
        }
        subscription.unsubscribe();
        account().get_by_tenant_id_and_account_id(TENANT, 2).await.unwrap().expect("a row").delete(false).await.unwrap();
        let after_cascade = membership().tenant_id(TENANT).get_count().await.unwrap();
        for tenant in [TENANT, OTHER_TENANT] {
            account().tenant_id(tenant).gets().await.unwrap().delete(false).await.unwrap();
        }
        assert_eq!(by_key, "b", "row by both key components");
        for (path, got) in results {
            assert_eq!(
                got,
                [format!("{TENANT}/1:{TENANT}/1/member"), format!("{TENANT}/2:{TENANT}/2/owner"), format!("{TENANT}/3:{TENANT}/3/editor"),],
                "{path}: memberships of tenant {TENANT} accounts"
            );
        }
        {
            let relation_events = relation_events.lock().unwrap();
            assert_eq!(relation_events.len(), 2, "both relation paths execute one relation statement");
            let expected_parent_binds = [
                polyspec_orm::Param::I64(TENANT),
                polyspec_orm::Param::I64(1),
                polyspec_orm::Param::I64(TENANT),
                polyspec_orm::Param::I64(2),
                polyspec_orm::Param::I64(TENANT),
                polyspec_orm::Param::I64(3),
                polyspec_orm::Param::I64(TENANT),
                polyspec_orm::Param::I64(3),
            ];
            for (sql, binds) in relation_events.iter() {
                assert_eq!(binds, &expected_parent_binds, "three composite parent keys repeat the last tuple");
                let placeholders = if sql.contains('?') { sql.matches('?').count() } else { (1..).take_while(|index| sql.contains(&format!("${index}"))).count() };
                assert_eq!(placeholders, 8, "three composite parent keys expand to four two-column tuples");
            }
        }
        for (path, child) in [("same statement", CompositeMembership::new()), ("own connection", CompositeMembership::new().connect(&db))] {
            assert_eq!(
                format!("{}{}", collision_rows[0].0, collision_rows[0].1),
                format!("{}{}", collision_rows[1].0, collision_rows[1].1),
                "the collision fixture has equal concatenated composite keys"
            );
            let loaded = account()
                .tuple_tenant_id_with_account_id(vec![(collision_rows[0].0, collision_rows[0].1), (collision_rows[1].0, collision_rows[1].1)])
                .order_by_tenant_id_asc()
                .order_by_account_id_asc()
                .relations(child.match_tenant_id_with_tenant_id().match_account_id_with_account_id().alias_memberships())
                .gets()
                .await
                .unwrap();
            let got = relation_rows(loaded.models());
            assert_eq!(
                got,
                [
                    format!("{}/{}:{}/{}/{}", collision_rows[0].0, collision_rows[0].1, collision_rows[0].0, collision_rows[0].1, collision_rows[0].3),
                    format!("{}/{}:{}/{}/{}", collision_rows[1].0, collision_rows[1].1, collision_rows[1].0, collision_rows[1].1, collision_rows[1].3),
                ],
                "{path}: colliding concatenated composite keys keep relations separate"
            );
        }
        assert_eq!(after_cascade, 2, "ON DELETE CASCADE removed the membership of account 2");
        for tenant in [TENANT, OTHER_TENANT, collision_tenants[0], collision_tenants[1]] {
            assert_eq!(account().tenant_id(tenant).get_count().await.unwrap(), 0, "accounts of tenant {tenant} left");
            assert_eq!(membership().tenant_id(tenant).get_count().await.unwrap(), 0, "memberships of tenant {tenant} left");
        }
        db.close().await;
    })
    .await;
}
