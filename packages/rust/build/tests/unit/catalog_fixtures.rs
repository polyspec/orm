use crate::catalog::{RowSnapshot, TableColumnMetadata, TableKind, TableMetadata, TablePage, TableRef};
use crate::tool_db::{GridCell, GridQueryResult, QueryColumn};

pub(super) fn metadata(table: &str, value_column: &str) -> TableMetadata {
    TableMetadata {
        table: TableRef { namespace: "main".into(), name: table.into() },
        kind: TableKind::Table,
        columns: vec![
            TableColumnMetadata {
                name: "id".into(),
                native_type: "INTEGER".into(),
                nullable: false,
                generated: false,
                automatic_key: false,
                default_expression: None,
                expression_default: false,
            },
            TableColumnMetadata {
                name: value_column.into(),
                native_type: "TEXT".into(),
                nullable: false,
                generated: false,
                automatic_key: false,
                default_expression: None,
                expression_default: false,
            },
        ],
        primary_key: vec!["id".into()],
        reliable_row_identity: true,
    }
}

pub(super) fn row_snapshot(table: &str, value_column: &str, id_native_type: &str) -> RowSnapshot {
    let mut metadata = metadata(table, value_column);
    metadata.columns[0].native_type = id_native_type.into();
    let page = TablePage {
        metadata,
        result: GridQueryResult {
            columns: vec![
                QueryColumn { name: "id".into(), native_type: id_native_type.into() },
                QueryColumn { name: value_column.into(), native_type: "TEXT".into() },
            ],
            rows: vec![vec![GridCell::Integer(1), GridCell::Text("original".into())]],
        },
        limit: 1,
        offset: 0,
        order_by: vec!["id".into()],
        has_more: false,
    };
    RowSnapshot::from_page(&page, 0).expect("valid one-row catalog fixture")
}
