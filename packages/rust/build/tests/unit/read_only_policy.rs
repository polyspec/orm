use super::validate;
use std::error::Error;
#[test]
fn parser_failure_keeps_its_cause_without_exposing_input_details() {
    let _case = polyspec_orm_testcase::case!();
    let error = validate("SELECT '", "postgres").expect_err("unterminated string must fail");
    assert_eq!(error.to_string(), "query_read_only: expected one supported non-locking read query");
    assert!(error.source().is_some_and(|cause| cause.to_string().contains("Unterminated string literal")));
}
