//! The shared styled column states of contracts/fixtures/styled_column_states.json through the public codec API
//! (`polyspec_orm::codec`), one libtest-mimic trial `styled_column_state_fixture::<id>` per case. The codec cases that
//! every client shares are the codec recipe, tests/codec/codec.json (packages/rust/tests/tests/all/codec_none.rs).

use crate::or_panic;
use or_panic::OrPanic;

use polyspec_orm::codec::{check_setter, check_setter_ordered, decode, encode, encode_ordered};
use polyspec_orm::codes::CODEC_DECODE;
use polyspec_orm::{ordered_json, Param, StyledValue, Val};
use polyspec_orm_testcase::Trial;
use serde_json::Value;

/// The serde_json form of an ordered-json value, from its compact text.
fn ordered_json_value(value: &ordered_json::Value) -> Value {
    match parse_deep(value.compact()) {
        Ok(json) => json,
        Err(error) => panic!("the ordered-json value has no serde_json form: {error}"),
    }
}

/// The JSON value of `text`, read to every level: the fixture and its values nest deeper than the 128 levels that serde_json reads by
/// default (COD-70), so the read runs on a thread with a stack of its own, which the recursion of serde_json to every level
/// of the fixture fits.
fn parse_deep(text: impl Into<String>) -> serde_json::Result<Value> {
    let text = text.into();
    let read = std::thread::Builder::new().stack_size(64 << 20).spawn(move || {
        use serde::Deserialize as _;
        let mut reader = serde_json::Deserializer::from_str(&text);
        reader.disable_recursion_limit();
        let value = Value::deserialize(&mut reader)?;
        reader.end()?;
        Ok(value)
    });
    match read.expect("a thread of the fixture read").join() {
        Ok(value) => value,
        Err(payload) => std::panic::resume_unwind(payload),
    }
}

/// Each case of contracts/fixtures/styled_column_states.json, one trial per case of the fixture: the stored value decodes
/// to its state and writes back unchanged, and a setter case states the error of the setter (COD-73).
fn styled_column_state_fixture() -> Vec<Trial> {
    let fixture = parse_deep(include_str!("../../../../../contracts/fixtures/styled_column_states.json")).expect("styled column state fixture");
    let cases = fixture["cases"].as_array().expect("cases array");
    assert!(!cases.is_empty(), "the fixture holds its cases");
    cases
        .iter()
        .map(|case| {
            let id = case["id"].as_str().expect("case ID").to_owned();
            let case = case.clone();
            polyspec_orm_testcase::trial(format!("styled_column_states::styled_column_state_fixture::{id}"), polyspec_orm_testcase::COMPUTE, move || {
                styled_case(&case)
            })
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
    if let Some(message) = case["message"].as_str() {
        setter_case(id, style, case, message);
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

/// A setter case: the setter of a column of the style takes the input value and fails at the call with the error of the
/// case, `message`, the whole text (COD-73). The setter is `check_setter`, which the generated setter of a styled column
/// calls before it changes the model, or `check_setter_ordered` for the ordered-json value of a column whose first stage is
/// `ordered_json`.
fn setter_case(id: &str, style: &str, case: &Value, message: &str) {
    assert_eq!(case["input"]["kind"].as_str(), Some("value"), "{id}: a setter case sets a value");
    let input = &case["input"]["value"];
    let result = if style == "ordered_json" {
        // The value of an ordered_json column is an ordered-json value, which is built from its JSON text.
        let text = serde_json::to_string(input).or_panic(|error| format!("{id}: the input has no JSON text: {error}"));
        if case["unreachable"]["rust"].is_string() {
            // COD-73: no Rust value of the column holds the input; the case proves it, since an ordered-json value is
            // built from its JSON text and holds at most ordered_json::MAX_DEPTH levels.
            let error = ordered_json::parse(&text).expect_err(&format!("{id}: the case states that no Rust value holds the input, but it parses"));
            assert!(error.to_string().contains("maximum nesting depth exceeded"), "{id}: the input is refused for another reason than its depth: {error}");
            return;
        }
        let value = ordered_json::parse(&text).or_panic(|error| format!("{id}: the input is no ordered-json value of a json column: {error}"));
        check_setter_ordered(&[style], &value)
    } else {
        check_setter(&[style], input)
    };
    let error = result.expect_err(&format!("{id}: the setter refuses the value"));
    assert_eq!(case["error"].as_str(), Some(error.code()), "{id}: setter code");
    assert_eq!(error.to_string(), message, "{id}: setter message");
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    styled_column_state_fixture()
}
