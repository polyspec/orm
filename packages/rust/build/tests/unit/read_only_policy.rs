use super::validate;
use std::error::Error;
#[test]
fn parser_failure_keeps_its_cause_without_exposing_input_details() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let error = validate("SELECT '", "postgres").expect_err("unterminated string must fail");
    assert_eq!(error.to_string(), "QUERY_READ_ONLY: expected one supported non-locking read query");
    assert!(error.source().is_some_and(|cause| cause.to_string().contains("Unterminated string literal")));
}

#[test]
fn postgres_refuses_a_read_at_its_operand_limit() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let union = std::iter::repeat_n("SELECT 1", 200).collect::<Vec<_>>().join(" UNION ALL ");
    assert!(validate(&union, "postgres").is_err(), "200 UNION ALL operands must fail");
    let plus = format!("SELECT {}", std::iter::repeat_n("1", 200).collect::<Vec<_>>().join("+"));
    assert!(validate(&plus, "postgres").is_err(), "200 + terms must fail");
}
