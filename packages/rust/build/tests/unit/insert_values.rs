use super::*;

fn metadata() -> TableMetadata {
    crate::catalog::test_fixtures::metadata("people", "name")
}

#[tokio::test]
async fn rust_duplicate_insert_assignment_budget_uses_the_shared_limit() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let metadata = metadata();
        let accepted = [("id".into(), P::I(1)), ("name".into(), P::S("ok".into()))];
        assert!(validate(&metadata, &accepted, "sqlite").is_ok());

        let oversized = [("id".into(), P::I(1)), ("name".into(), P::S("x".repeat(super::super::assignment_budget::MAX_BYTES + 1)))];
        let error = match validate(&metadata, &oversized, "sqlite") {
            Ok(_) => panic!("oversized insert assignment was accepted"),
            Err(error) => error,
        };
        assert!(error.starts_with("ROW_INSERT_LIMIT: assignment budget exceeded"));
    })
    .await
    .expect("insert assignment budget deadline");
}
