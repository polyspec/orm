use super::catalog_query_error;

#[test]
fn the_tool_statement_and_columns_errors_keep_their_codes_first() {
    let _case = polyspec_orm_testcase::case!();
    let statement = catalog_query_error(sqlx::Error::Decode("tool_query_statement: expected one statement".into()));
    assert!(statement.message().starts_with("tool_query_statement:"), "{statement}");
    assert!(statement.message().contains("expected one statement"), "{statement}");
    let columns = catalog_query_error(sqlx::Error::Decode("tool_query_columns: column metadata budget exceeded".into()));
    assert!(columns.message().starts_with("tool_query_columns:"), "{columns}");
    assert!(columns.message().contains("column metadata budget exceeded"), "{columns}");
    assert!(!columns.message().contains("error occurred while decoding"), "{columns}");
}
