use super::columns;

#[test]
fn metadata_budgets_reject_excess_and_preserve_exact_boundaries() {
    let started = std::time::Instant::now();
    eprintln!("running metadata_budgets");
    assert_eq!(columns(std::iter::repeat_n(("a", "INT"), 2048)).unwrap().len(), 2048);
    assert!(columns(std::iter::repeat_n(("a", "INT"), 2049)).is_err());
    let name = "s".repeat(64 * 1024 - 3);
    assert!(columns([(name.as_str(), "INT")]).is_ok());
    let name = "s".repeat(64 * 1024 - 2);
    let error = columns([(name.as_str(), "INT")]).unwrap_err();
    assert!(error.to_string().contains("TOOL_QUERY_COLUMNS"));
    assert!(!error.to_string().contains(&name));
    eprintln!("passed metadata_budgets {:?}", started.elapsed());
}
