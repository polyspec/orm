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
#[tokio::test]
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
#[tokio::test]
// Requirements: INT-107.
async fn row_baseline_compares_exact_bits_scale_and_binary() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        for (original, changed) in [
            (GridCell::Float64(0), GridCell::Float64(1u64 << 63)),
            (GridCell::Decimal("100.23000".into()), GridCell::Decimal("100.23".into())),
            (GridCell::Binary(vec![0, 255]), GridCell::Binary(vec![0, 254])),
            (GridCell::Unsigned(u64::MAX), GridCell::Unsigned(u64::MAX - 1)),
            (GridCell::Boolean(false), GridCell::Integer(0)),
        ] {
            let mut page = fixture();
            page.result.rows[0][1] = original.clone();
            let snapshot = RowSnapshot::from_page(&page, 0).unwrap();
            snapshot.check_current(&page.metadata, &page.result).unwrap();
            assert_eq!(snapshot.cells()[1], original);
            page.result.rows[0][1] = changed;
            assert!(snapshot.check_current(&page.metadata, &page.result).unwrap_err().starts_with("ROW_CONFLICT"));
            assert_ne!(snapshot.revision(), RowSnapshot::from_page(&page, 0).unwrap().revision());
        }

        let mut generated = fixture();
        generated.metadata.columns[1].generated = true;
        generated.result.rows[0][1] = GridCell::Text("generated-original".into());
        let snapshot = RowSnapshot::from_page(&generated, 0).unwrap();
        assert_eq!(snapshot.cells()[1], GridCell::Text("generated-original".into()));
        let mut changed = generated.result.clone();
        changed.rows[0][1] = GridCell::Text("generated-current".into());
        assert!(snapshot.check_current(&generated.metadata, &changed).unwrap_err().starts_with("ROW_CONFLICT"));
    })
    .await
    .expect("row snapshot exact deadline");
}
