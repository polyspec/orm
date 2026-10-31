//! The shared styled column states of contracts/fixtures/styled_column_states.json through the public codec API
//! (`polyspec_orm::codec`), one libtest-mimic trial `styled_column_state_fixture::<id>` per case. The codec cases that
//! every client shares are the codec recipe, tests/codec/codec.json (packages/rust/tests/tests/codec_none.rs).

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

use polyspec_orm::codec::{decode, encode, encode_ordered};
use polyspec_orm::codes::CODEC_DECODE;
use polyspec_orm::{ordered_json, Param, StyledValue, Val};
use polyspec_orm_testcase::Trial;
use serde_json::Value;

/// The serde_json form of an ordered-json value, from its compact text.
fn ordered_json_value(value: &ordered_json::Value) -> Value {
    match serde_json::from_str(&value.compact()) {
        Ok(json) => json,
        Err(error) => panic!("the ordered-json value has no serde_json form: {error}"),
    }
}

/// Each case of contracts/fixtures/styled_column_states.json: the stored value decodes to its state and writes back
/// unchanged.
fn styled_column_state_fixture() -> Vec<Trial> {
    let fixture: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/styled_column_states.json")).expect("styled column state fixture");
    let cases = fixture["cases"].as_array().expect("cases array");
    assert_eq!(cases.len(), 13, "every shared styled-column case remains present");
    cases
        .iter()
        .map(|case| {
            let id = case["id"].as_str().expect("case ID").to_owned();
            let case = case.clone();
            polyspec_orm_testcase::trial(format!("styled_column_state_fixture::{id}"), polyspec_orm_testcase::COMPUTE, move || styled_case(&case))
        })
        .collect()
}

fn styled_case(case: &Value) {
    let id = case["id"].as_str().expect("case ID");
    // The `json` and `jsons` stages of the fixture are the `ordered_json` stage of dbspec.
    let style = match case["style"].as_str().expect("style") {
        "json" | "jsons" => "ordered_json",
        other => other,
    };
    if id == "unselected" {
        assert_eq!(case["getter_error"].as_str(), Some("COLUMN_UNSELECTED"), "{id}: getter contract");
        assert_eq!(case["requested_output_error"].as_str(), Some("COLUMN_UNSELECTED"), "{id}: output contract");
        return;
    }
    if id == "nonnull_sql_null" {
        assert_eq!(case["error"].as_str(), Some("CODEC_ENCODE"), "{id}: setter contract");
        return;
    }
    let raw = match case["stored_text"].as_str() {
        Some(text) => Val::Str(text.into()),
        None => Val::Null,
    };
    let decoded = decode(&[style.into()], &raw);
    if id == "empty_text" {
        assert_eq!(decoded.unwrap_err().code(), CODEC_DECODE, "{id}");
        return;
    }
    let decoded = decoded.or_panic(|error| format!("{id}: {error}"));
    let expected = &case["output"];
    let output = match &decoded {
        Val::Null => serde_json::json!({"kind": "sql-null"}),
        Val::Ordered(value) => serde_json::json!({"kind": "value", "value": ordered_json_value(value)}),
        Val::Json(value) => serde_json::json!({"kind": "value", "value": value}),
        other => panic!("{id}: unexpected decoded value {other:?}"),
    };
    assert_eq!(&output, expected, "{id}: decoded state");
    if !case["input"].is_object() {
        return;
    }
    let written = match &decoded {
        Val::Null => encode(&[style], StyledValue::SqlNull).unwrap(),
        Val::Ordered(value) => encode_ordered(&[style], StyledValue::Value(value)).unwrap(),
        Val::Json(value) => encode(&[style], StyledValue::Value(value)).unwrap(),
        _ => unreachable!(),
    };
    if let Some(expected) = case.get("write_text") {
        let expected_write = match expected.as_str() {
            Some(text) => Param::Str(text.into()),
            None if expected.is_null() => Param::Null,
            _ => panic!("{id}: invalid fixture write_text"),
        };
        assert_eq!(written, expected_write, "{id}: stored value");
    } else {
        assert_eq!(style, "yaml", "{id}: only YAML may omit exact write text");
        let encoded = match written {
            Param::Null => Val::Null,
            Param::Str(text) => Val::Str(text),
            other => panic!("{id}: YAML write is not text or SQL NULL: {other:?}"),
        };
        assert_eq!(decode(&[style.into()], &encoded).unwrap(), decoded, "{id}: decoded write");
    }
}

fn main() {
    polyspec_orm_testcase::run(styled_column_state_fixture());
}
