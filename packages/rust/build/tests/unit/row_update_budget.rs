use crate::catalog::{RowSnapshot, TablePage};
use crate::tool_db::{GridCell, GridQueryResult, QueryColumn};

fn snapshot() -> RowSnapshot {
    let metadata = crate::catalog::test_fixtures::metadata("fixture", "value");
    let page = TablePage {
        metadata,
        result: GridQueryResult {
            columns: vec![QueryColumn { name: "id".into(), native_type: "INT8".into() }, QueryColumn { name: "value".into(), native_type: "TEXT".into() }],
            rows: vec![vec![GridCell::Integer(1), GridCell::Text("original".into())]],
        },
        limit: 1,
        offset: 0,
        order_by: vec!["id".into()],
        has_more: false,
    };
    RowSnapshot::from_page(&page, 0).unwrap()
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
