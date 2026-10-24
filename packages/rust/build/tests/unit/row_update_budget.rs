use crate::catalog::RowSnapshot;
use crate::tool_db::GridCell;

fn snapshot() -> RowSnapshot {
    crate::catalog::test_fixtures::row_snapshot("fixture", "value", "INT8")
}

#[tokio::test]
async fn rust_duplicate_update_assignment_budget_preserves_its_error_cause() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let snapshot = snapshot();
        let oversized = vec![("value".to_owned(), GridCell::Text("x".repeat(8 * 1024 * 1024 + 1)))];
        let error = snapshot.validate_update(&oversized).unwrap_err();
        assert!(error.starts_with("ROW_UPDATE_LIMIT: assignment budget exceeded"));
    })
    .await
    .expect("row update assignment budget deadline");
}
