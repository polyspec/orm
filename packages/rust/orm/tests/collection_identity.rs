//! The collection key identity of tests/collection/keys.json: every value type has its own key, equal instants share one,
//! and a NULL key is CODEC_DECODE. The unit test reads the fixture and needs no database.
//! Usage: cargo test -p polyspec-orm --test collection_identity (from packages/rust).

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

use polyspec_orm::chrono::DateTime;
use polyspec_orm::plan::KeyRef;
use polyspec_orm::{Error, Key, Val};
use serde_json::Value as Json;

fn fixture() -> Json {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../tests/collection/keys.json");
    let src = std::fs::read_to_string(path).or_panic(|e| format!("read {path}: {e}; run make orm-check from the checkout root"));
    serde_json::from_str(&src).expect("tests/collection/keys.json is not JSON")
}

fn value_of(entry: &Json) -> Val {
    let name = entry["name"].as_str().unwrap_or("?");
    if let Some(value) = scalar_value(entry) {
        return value;
    }
    match entry["type"].as_str() {
        Some("datetime") => {
            let instant = DateTime::parse_from_rfc3339(entry["value"].as_str().expect("datetime value")).or_panic(|e| format!("fixture {name}: {e}"));
            Val::DateTime(instant.naive_utc())
        }
        other => panic!("fixture {name} has unknown type {other:?}"),
    }
}

fn composite_value_of(entry: &Json) -> Val {
    if let Some(value) = scalar_value(entry) {
        return value;
    }
    match entry["type"].as_str() {
        Some("datetime") => {
            let instant = DateTime::parse_from_rfc3339(entry["value"].as_str().expect("datetime value")).expect("datetime value");
            Val::DateTime(instant.naive_utc())
        }
        Some("null") => Val::Null,
        other => panic!("unknown composite component type {other:?}"),
    }
}

fn scalar_value(entry: &Json) -> Option<Val> {
    match entry["type"].as_str()? {
        "text" => Some(Val::Str(entry["value"].as_str().expect("text value").to_owned())),
        "bool" => Some(Val::Bool(entry["value"].as_bool().expect("bool value"))),
        "int" => Some(Val::I64(entry["value"].as_i64().expect("int value"))),
        "bytes" => Some(Val::Bytes(hex_decode(entry["hex"].as_str().expect("bytes hex")))),
        _ => None,
    }
}

fn remember_key(name: String, key: Key, same_as: Option<&str>, seen: &mut Vec<(String, Key)>) {
    if let Some(same_as) = same_as {
        let target = &seen.iter().find(|(n, _)| n == same_as).expect("same_as names an earlier key").1;
        assert_eq!(&key, target, "key {name} differs from {same_as}");
        return;
    }
    for (other, other_key) in seen.iter() {
        assert_ne!(other_key, &key, "keys {other} and {name} have the same identity");
    }
    seen.push((name, key));
}

fn hex_decode(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("fixture hex")).collect()
}

#[test]
fn every_fixture_key_has_its_own_identity() {
    // Requirements: INT-11, INT-63, PRT-35.
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let fixture = fixture();
    let entries = fixture["keys"].as_array().expect("keys");
    let mut seen: Vec<(String, Key)> = Vec::new();
    for entry in entries {
        let name = entry["name"].as_str().expect("name").to_owned();
        let key = Key::of(&value_of(entry)).or_panic(|e| format!("key {name}: {e}"));
        let again = Key::of(&value_of(entry)).expect("key again");
        assert_eq!(key, again, "key {name} has no stable identity");
        let preserves_native_type = matches!(
            (entry["type"].as_str(), &key),
            (Some("text"), Key::S(_)) | (Some("bool"), Key::B(_)) | (Some("int"), Key::I(_)) | (Some("bytes"), Key::X(_)) | (Some("datetime"), Key::T(_))
        );
        assert!(preserves_native_type, "key {name} lost its native type: {key:?}");
        remember_key(name, key, entry["same_as"].as_str(), &mut seen);
    }
}

#[test]
fn a_null_key_is_codec_decode() {
    // Requirements: PRT-35.
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let expected = fixture()["null"].clone();
    match Key::of(&Val::Null) {
        Err(Error::Engine { code, msg }) => {
            assert_eq!(code, expected["code"].as_str().unwrap());
            assert_eq!(msg, expected["message"].as_str().unwrap());
        }
        other => panic!("a NULL collection key gave {other:?}"),
    }
}

#[test]
fn composite_components_preserve_typed_identity_and_shared_encoding() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let fixture = fixture();
    let entries = fixture["composites"].as_array().expect("composites");
    let mut seen: Vec<(String, Key)> = Vec::new();
    for entry in entries {
        let name = entry["name"].as_str().expect("name").to_owned();
        let values: Vec<Val> = entry["values"].as_array().expect("values").iter().map(composite_value_of).collect();
        let key = Key::of_values(&values).or_panic(|e| format!("key {name}: {e}"));
        assert_eq!(key, Key::S(entry["encoded"].as_str().expect("encoded").to_owned()), "key {name}");
        assert_eq!(Key::of_values(&values).expect("key again"), key, "key {name} changed on repeated creation");
        remember_key(name, key, entry["same_as"].as_str(), &mut seen);
    }
}

#[test]
fn composite_datetime_microseconds_trim_trailing_zeroes() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for entry in fixture()["datetime_microseconds"].as_array().expect("datetime_microseconds") {
        let name = entry["name"].as_str().expect("name");
        let instant = DateTime::parse_from_rfc3339(entry["value"].as_str().expect("value")).or_panic(|e| format!("fixture {name}: {e}"));
        let values = vec![Val::DateTime(instant.naive_utc()), Val::Str(String::new())];
        let key = Key::of_values(&values).or_panic(|e| format!("key {name}: {e}"));
        assert_eq!(key, Key::S(entry["encoded"].as_str().expect("encoded").to_owned()), "key {name}");
        assert_eq!(Key::of_values(&values).expect("key again"), key, "key {name} changed on repeated creation");
    }
}

#[test]
fn a_null_composite_row_has_no_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let values: Vec<Val> = fixture()["nullable_composite"].as_array().expect("nullable_composite").iter().map(composite_value_of).collect();
    let refs = vec![KeyRef { column: "first".into(), index: 0 }, KeyRef { column: "second".into(), index: 1 }];
    assert!(Key::of_row(&values, &refs).expect("nullable row result").is_none());
}
