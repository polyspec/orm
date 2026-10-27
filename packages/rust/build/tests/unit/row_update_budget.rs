use crate::catalog::RowSnapshot;
use crate::catalog::TablePage;
use crate::tool_db::{GridCell, GridQueryResult, QueryColumn};

fn snapshot() -> RowSnapshot {
    crate::catalog::test_fixtures::row_snapshot("fixture", "value", "INT8")
}

fn snapshot_with_value_type(native_type: &str, value: GridCell) -> RowSnapshot {
    let mut metadata = crate::catalog::test_fixtures::metadata("fixture", "value");
    metadata.columns[1].native_type = native_type.into();
    let page = TablePage {
        metadata,
        result: GridQueryResult {
            columns: vec![
                QueryColumn { name: "id".into(), native_type: "INTEGER".into() },
                QueryColumn { name: "value".into(), native_type: native_type.into() },
            ],
            rows: vec![vec![GridCell::Integer(1), value]],
        },
        limit: 1,
        offset: 0,
        order_by: vec!["id".into()],
        has_more: false,
    };
    RowSnapshot::from_page(&page, 0).expect("valid one-row capacity fixture")
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

#[test]
fn rust_row_update_enforces_declared_varchar_and_binary_capacity() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let varchar = snapshot_with_value_type("VARCHAR (3)", GridCell::Text("old".into()));
    assert!(varchar.validate_update(&[("value".into(), GridCell::Text("界界界".into()))]).is_ok());
    let error = varchar.validate_update(&[("value".into(), GridCell::Text("界界界界".into()))]).unwrap_err();
    assert_eq!(error, "ROW_UPDATE_INVALID: invalid column assignments: value exceeds the declared capacity of column \"value\"");

    let varying = snapshot_with_value_type("CHARACTER VARYING(3)", GridCell::Text("old".into()));
    let error = varying.validate_update(&[("value".into(), GridCell::Text("界界界界".into()))]).unwrap_err();
    assert!(error.starts_with("ROW_UPDATE_INVALID: invalid column assignments: value exceeds the declared capacity"), "{error}");

    let varbinary = snapshot_with_value_type("VARBINARY(3)", GridCell::Binary(vec![1, 2, 3]));
    assert!(varbinary.validate_update(&[("value".into(), GridCell::Binary(vec![4, 5, 6]))]).is_ok());
    let error = varbinary.validate_update(&[("value".into(), GridCell::Binary(vec![4, 5, 6, 7]))]).unwrap_err();
    assert!(error.starts_with("ROW_UPDATE_INVALID: invalid column assignments: value exceeds the declared capacity"), "{error}");

    let binary = snapshot_with_value_type("binary(3)", GridCell::Binary(vec![1]));
    let error = binary.validate_update(&[("value".into(), GridCell::Text("éé".into()))]).unwrap_err();
    assert!(error.starts_with("ROW_UPDATE_INVALID: invalid column assignments: value exceeds the declared capacity"), "{error}");

    let fixed_character = snapshot_with_value_type("char(3)", GridCell::Text("old".into()));
    assert!(fixed_character.validate_update(&[("value".into(), GridCell::Text("界界界界".into()))]).is_ok());

    let overflowing_capacity = snapshot_with_value_type("varchar(999999999999999999999999999999)", GridCell::Text("old".into()));
    let error = overflowing_capacity.validate_update(&[("value".into(), GridCell::Text("new".into()))]).unwrap_err();
    assert!(error.contains("number too large to fit in target type"), "{error}");
}
