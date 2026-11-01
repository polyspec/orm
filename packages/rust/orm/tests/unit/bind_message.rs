//! bind_message: the answer value of a markdown read. The message cases of tests/bind/messages.json run through the recipe.
use super::answer_value;

#[test]
fn markdown_answer_value_preserves_base64_cause_message() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let raw = serde_json::value::RawValue::from_string("\"not-base64!\"".into()).expect("valid raw JSON string");
    let error = answer_value("bytes", &raw).expect_err("invalid base64 must fail");
    assert_eq!(error.code(), crate::codes::CODEC_DECODE);
    assert!(error.to_string().contains("Invalid symbol"), "{error}");
}
