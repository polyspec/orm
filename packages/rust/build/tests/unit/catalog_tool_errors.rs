use super::catalog_query_error;

#[test]
fn the_tool_statement_and_columns_errors_keep_their_codes_first() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let statement = catalog_query_error(sqlx::Error::Decode("TOOL_QUERY_STATEMENT: expected one statement".into()));
    assert!(statement.starts_with("TOOL_QUERY_STATEMENT:"), "{statement}");
    assert!(statement.contains("expected one statement"), "{statement}");
    let columns = catalog_query_error(sqlx::Error::Decode("TOOL_QUERY_COLUMNS: column metadata budget exceeded".into()));
    assert!(columns.starts_with("TOOL_QUERY_COLUMNS:"), "{columns}");
    assert!(columns.contains("column metadata budget exceeded"), "{columns}");
    assert!(!columns.contains("error occurred while decoding"), "{columns}");
}
