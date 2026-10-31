use super::catalog_query_error;

#[test]
fn an_unsupported_cell_fails_with_catalog_value() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let error = catalog_query_error(sqlx::Error::Decode("TOOL_QUERY_VALUE: unsupported catalog cell type TIMESTAMP".into()));
    assert!(error.starts_with("CATALOG_VALUE:"), "{error}");
    assert!(error.contains("TIMESTAMP"), "{error}");
}

#[test]
fn the_tool_value_and_limit_errors_keep_their_catalog_codes() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let value = catalog_query_error(crate::tool_db::unsupported_value("unsupported catalog cell type timestamptz"));
    assert!(value.starts_with("CATALOG_VALUE:"), "{value}");
    assert!(value.contains("timestamptz"), "{value}");
    let limit = catalog_query_error(sqlx::Error::Decode("TOOL_QUERY_LIMIT: invalid or exceeded result budget".into()));
    assert!(limit.starts_with("CATALOG_LIMIT:"), "{limit}");
}
