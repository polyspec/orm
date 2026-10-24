use super::*;
use crate::catalog::{TableColumnMetadata, TableKind, TableRef};

fn metadata() -> TableMetadata {
    TableMetadata {
        table: TableRef { namespace: "main".into(), name: "people".into() },
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
                name: "name".into(),
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
