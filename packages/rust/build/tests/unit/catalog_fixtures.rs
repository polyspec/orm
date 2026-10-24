use crate::catalog::{TableColumnMetadata, TableKind, TableMetadata, TableRef};

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
