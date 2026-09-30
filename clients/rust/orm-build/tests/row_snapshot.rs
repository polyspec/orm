use orm_build::{
    catalog::{RowSnapshot, TableColumnMetadata, TableKind, TableMetadata, TablePage, TableRef},
    tool_db::{GridCell, GridQueryResult, QueryColumn},
};
fn fixture() -> TablePage {
    TablePage {
        metadata: TableMetadata {
            table: TableRef { namespace: "main".into(), name: "fixture".into() },
            kind: TableKind::Table,
            columns: vec![
                TableColumnMetadata { name: "a".into(), native_type: "INTEGER".into(), nullable: false, generated: false, automatic_key: false, default_expression: None, expression_default: false },
                TableColumnMetadata { name: "b".into(), native_type: "TEXT".into(), nullable: false, generated: false, automatic_key: false, default_expression: None, expression_default: false },
            ],
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
async fn row_update_verification_rejects_coercion_and_unrequested_changes() {
    let began=std::time::Instant::now();
    eprintln!("running row_update_verification");
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        let page=fixture();
        let original=RowSnapshot::from_page(&page,0).unwrap();
        let changes=vec![("b".to_owned(),GridCell::Text("assigned".into()))];
        original.validate_update(&changes).unwrap();
        let mut current=page.result.clone();
        current.rows[0][1]=GridCell::Text("assigned".into());
        original.check_updated(&page.metadata,&current,&changes).unwrap();
        current.rows[0][0]=GridCell::Integer(0);
        assert!(original.check_updated(&page.metadata,&current,&changes).unwrap_err().starts_with("ROW_WRITE_MISMATCH"));
        current=page.result.clone();
        assert!(original.check_updated(&page.metadata,&current,&changes).unwrap_err().starts_with("ROW_WRITE_MISMATCH"));
        for invalid in [vec![],vec![("absent".into(),GridCell::Null)],vec![("b".into(),GridCell::Null)],vec![changes[0].clone(),changes[0].clone()]] {
            assert!(original.validate_update(&invalid).is_err());
        }
        let mut generated=fixture();
        generated.metadata.columns[1].generated=true;
        let snapshot=RowSnapshot::from_page(&generated,0).unwrap();
        assert!(snapshot.validate_update(&changes).is_err());
        let assigned=vec![("a".into(),GridCell::Integer(42))];
        let mut result=generated.result.clone();
        result.rows[0]=vec![GridCell::Integer(42),GridCell::Text("recomputed".into())];
        snapshot.check_updated(&generated.metadata,&result,&assigned).unwrap();
    }).await.expect("row update verification deadline");
    eprintln!("passed row_update_verification {:?}",began.elapsed());
}
#[tokio::test]
async fn row_baseline_preserves_immutable_values_and_key_order() {
    let began = std::time::Instant::now();
    eprintln!("running row_snapshot");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut page = fixture();
        let snapshot = RowSnapshot::from_page(&page, 0).unwrap();
        let revision = snapshot.revision().to_owned();
        assert_eq!(snapshot.key().map(|(name, _)| name).collect::<Vec<_>>(), vec!["b", "a"]);
        assert_eq!(revision.len(), 64);
        snapshot.check_current(&page.metadata, &page.result).unwrap();
        page.result.rows[0][1] = GridCell::Text("private-changed".into());
        assert_eq!(snapshot.cells()[1], GridCell::Text("private-original".into()));
        assert!(snapshot.check_current(&page.metadata, &page.result).unwrap_err().starts_with("ROW_CONFLICT"));
        assert_ne!(RowSnapshot::from_page(&page, 0).unwrap().revision(), revision);
    })
    .await
    .expect("row snapshot deadline");
    eprintln!("passed row_snapshot {:?}", began.elapsed());
}
#[tokio::test]
async fn row_baseline_rejects_invalid_identity_and_distinguishes_conflicts() {
    let began = std::time::Instant::now();
    eprintln!("running row_snapshot_validation");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        for change in 0..10 {
            let mut page = fixture();
            match change {
                0 => page.metadata.kind = TableKind::View,
                1 => page.metadata.reliable_row_identity = false,
                2 => page.metadata.primary_key.clear(),
                3 => page.metadata.primary_key.push("a".into()),
                4 => page.metadata.columns[0].nullable = true,
                5 => page.result.rows[0][0] = GridCell::Null,
                6 => page.result.columns[0].name = "other".into(),
                7 => page.result.rows[0].pop().map(|_| ()).unwrap(),
                8 => page.result.rows[0][0] = GridCell::Decimal("1e3".into()),
                _ => page.limit = 0,
            }
            assert!(RowSnapshot::from_page(&page, 0).is_err());
        }
        let page = fixture();
        let snapshot = RowSnapshot::from_page(&page, 0).unwrap();
        assert!(RowSnapshot::from_page(&page, 1).is_err());
        assert!(!format!("{snapshot:?}").contains("private-original"));
        let mut changed = page.metadata.clone();
        changed.columns[0].generated = true;
        assert!(snapshot.check_current(&changed, &page.result).unwrap_err().starts_with("ROW_SCHEMA_CHANGED"));
        let mut empty = page.result.clone();
        empty.rows.clear();
        assert!(snapshot.check_current(&page.metadata, &empty).unwrap_err().starts_with("ROW_CONFLICT"));
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
    eprintln!("passed row_snapshot_validation {:?}", began.elapsed());
}
#[tokio::test]
async fn row_baseline_compares_exact_bits_scale_and_binary() {
    let began = std::time::Instant::now();
    eprintln!("running row_snapshot_exact_cells");
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
    })
    .await
    .expect("row snapshot exact deadline");
    eprintln!("passed row_snapshot_exact_cells {:?}", began.elapsed());
}
