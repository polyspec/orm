use super::columns;

#[test]
// Requirements: INT-124.
fn metadata_budgets_reject_excess_and_preserve_exact_boundaries() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    assert_eq!(columns(0, std::iter::repeat_n(("a", "INT"), 2048)).unwrap().len(), 2048);
    assert!(columns(0, std::iter::repeat_n(("a", "INT"), 2049)).is_err());
    let name = "s".repeat(64 * 1024 - 3);
    assert!(columns(0, [(name.as_str(), "INT")]).is_ok());
    let name = "s".repeat(64 * 1024 - 2);
    let error = columns(0, [(name.as_str(), "INT")]).unwrap_err();
    assert!(error.to_string().contains("TOOL_QUERY_COLUMNS"));
    assert!(!error.to_string().contains(&name));
    assert!(columns(2, [(name.as_str(), "INT")]).is_ok());
    assert!(columns(1, [(name.as_str(), "INT")]).is_err());
}
