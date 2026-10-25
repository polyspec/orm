use super::*;

fn fixture() -> TablePage {
    TablePage {
        metadata: TableMetadata {
            table: super::super::TableRef { namespace: "main".into(), name: "fixture".into() },
            kind: TableKind::Table,
            columns: vec![super::super::TableColumnMetadata {
                name: "id".into(),
                native_type: "INTEGER".into(),
                nullable: false,
                generated: false,
                automatic_key: false,
                default_expression: None,
                expression_default: false,
            }],
            primary_key: vec!["id".into()],
            reliable_row_identity: true,
        },
        result: GridQueryResult {
            columns: vec![crate::tool_db::QueryColumn { name: "id".into(), native_type: "INTEGER".into() }],
            rows: vec![vec![GridCell::Integer(1)]],
        },
        limit: 1,
        offset: 0,
        order_by: vec!["id".into()],
        has_more: false,
    }
}

fn fixture_with_payload(value: GridCell) -> TablePage {
    let mut page = fixture();
    page.metadata.columns.push(super::super::TableColumnMetadata {
        name: "payload".into(),
        native_type: "TEXT".into(),
        nullable: false,
        generated: false,
        automatic_key: false,
        default_expression: None,
        expression_default: false,
    });
    page.result.columns.push(crate::tool_db::QueryColumn { name: "payload".into(), native_type: "TEXT".into() });
    page.result.rows[0].push(value);
    page
}

#[test]
fn primary_key_parameters_follow_declared_key_order() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let mut page = fixture();
    page.metadata.columns.push(super::super::TableColumnMetadata {
        name: "slug".into(),
        native_type: "TEXT".into(),
        nullable: false,
        generated: false,
        automatic_key: false,
        default_expression: None,
        expression_default: false,
    });
    page.metadata.primary_key = vec!["slug".into(), "id".into()];
    let keys = key_params(&page.metadata, &[GridCell::Integer(7), GridCell::Text("row-key".into())]).unwrap();
    assert!(matches!(keys.as_slice(), [P::S(slug), P::I(7)] if slug == "row-key"));
}

#[test]
fn row_snapshot_uses_shared_decimal_syntax_validation() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let page = fixture();
    for value in ["0", "-0", "100.23000", "-12345678901234567890.00001"] {
        assert!(row(&page.metadata, &[GridCell::Decimal(value.into())]).is_ok(), "{value}");
    }
    for value in ["", "01", "-", "+1", "1.", "1e3", "NaN"] {
        assert!(row(&page.metadata, &[GridCell::Decimal(value.into())]).is_err(), "{value}");
    }
}

#[test]
fn row_snapshot_descriptor_and_update_preserve_cause_message() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let mut page = fixture();
    page.metadata.table.name.clear();
    let error = RowSnapshot::from_page(&page, 0).expect_err("empty table name must fail");
    assert!(
        error.contains("ROW_SNAPSHOT_INVALID: invalid original row or descriptor: TABLE_REFERENCE_INVALID: expected 1..1024 UTF-8 bytes without NUL"),
        "{error}"
    );

    let mut page = fixture();
    page.metadata.columns[0].name.clear();
    let error = RowSnapshot::from_page(&page, 0).expect_err("empty column name must fail");
    assert!(
        error.contains("ROW_SNAPSHOT_INVALID: invalid original row or descriptor: TABLE_REFERENCE_INVALID: expected 1..1024 UTF-8 bytes without NUL"),
        "{error}"
    );

    let snapshot = RowSnapshot::from_page(&fixture(), 0).expect("valid page");
    let error = snapshot.validate_update(&[("id".into(), GridCell::Decimal("01".into()))]).expect_err("invalid decimal assignment must fail");
    assert!(error.contains("ROW_UPDATE_INVALID: invalid column assignments: ROW_SNAPSHOT_INVALID: invalid original row or descriptor"), "{error}");

    let page = fixture_with_payload(GridCell::Text("small".into()));
    let snapshot = RowSnapshot::from_page(&page, 0).expect("valid page with payload");
    let huge = GridCell::Text("x".repeat(8 * 1024 * 1024 - 64));
    let error = snapshot.validate_update(&[("payload".into(), huge)]).expect_err("oversized update must fail");
    assert!(
        error.contains(
            "ROW_UPDATE_LIMIT: updated row budget exceeded: ROW_SNAPSHOT_LIMIT: original row encoding exceeds its budget: row snapshot budget exceeded"
        ),
        "{error}"
    );
}

#[test]
fn row_snapshot_revision_preserves_writer_cause_message() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let page = fixture_with_payload(GridCell::Text("x".repeat(8 * 1024 * 1024 + 1)));
    let error = RowSnapshot::from_page(&page, 0).expect_err("oversized row must fail");
    assert!(error.contains("ROW_SNAPSHOT_LIMIT: original row encoding exceeds its budget: row snapshot budget exceeded"), "{error}");
}
