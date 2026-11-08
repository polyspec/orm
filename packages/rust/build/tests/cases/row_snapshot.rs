#[path = "common/table_column.rs"]
mod table_column;
use table_column::plain_column;

use polyspec_orm_build::{
    catalog::{RowSnapshot, TableColumnMetadata, TableKind, TableMetadata, TablePage, TableRef},
    tool_db::{GridCell, GridQueryResult, QueryColumn},
};
fn fixture() -> TablePage {
    TablePage {
        metadata: TableMetadata {
            table: TableRef { namespace: "main".into(), name: "fixture".into() },
            kind: TableKind::Table,
            columns: vec![plain_column("a", "INTEGER", false), plain_column("b", "TEXT", false)],
            primary_key: vec!["b".into(), "a".into()],
            reliable_row_identity: true,
        },
        result: GridQueryResult {
            columns: vec![QueryColumn { name: "a".into(), native_type: "INT8".into() }, QueryColumn { name: "b".into(), native_type: "TEXT".into() }],
            rows: vec![vec![GridCell::Integer(i64::MAX), GridCell::Text("private-original".into())]],
        },
        limit: 1,
        offset: 0,
        order_by: vec!["b".into(), "a".into()],
        has_more: false,
    }
}
#[tokio::main(flavor = "current_thread")]
// Requirements: INT-109a.
// Runtime-unique (FCV-14): GridCell::Decimal and the Debug form are Rust's own, and no
// primary key of a database selects two rows, so only this direct call of check_current holds an ambiguous identity.
async fn row_baseline_rejects_what_only_the_rust_forms_hold() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut malformed = fixture();
        malformed.result.rows[0][0] = GridCell::Decimal("1e3".into());
        assert!(RowSnapshot::from_page(&malformed, 0).is_err());
        let page = fixture();
        let snapshot = RowSnapshot::from_page(&page, 0).unwrap();
        assert!(!format!("{snapshot:?}").contains("private-original"));
        let mut ambiguous = page.result.clone();
        ambiguous.rows.push(ambiguous.rows[0].clone());
        assert!(snapshot.check_current(&page.metadata, &ambiguous).unwrap_err().starts_with("ROW_IDENTITY_AMBIGUOUS"));
        let mut huge = fixture();
        huge.result.rows[0][1] = GridCell::Text("private".repeat(2 * 1024 * 1024));
        let error = RowSnapshot::from_page(&huge, 0).unwrap_err();
        assert!(error.starts_with("ROW_SNAPSHOT_LIMIT") && !error.contains("private"));
    })
    .await
    .expect("row snapshot validation deadline");
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("row_snapshot": row_baseline_rejects_what_only_the_rust_forms_hold)
}
