//! The collection key identity of tests/collection/keys.json: every value type has its own key, equal instants share one,
//! and a NULL key is CODEC_DECODE. The unit test reads the fixture and needs no database.
//! Usage: cargo test -p polyspec-orm --test collection_identity (from packages/rust).

use polyspec_orm::chrono::DateTime;
use polyspec_orm::{Error, Key, Val};
use serde_json::Value as Json;

fn fixture() -> Json {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../tests/collection/keys.json");
    let src = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}; run make orm-check from the checkout root"));
    serde_json::from_str(&src).expect("tests/collection/keys.json is not JSON")
}

fn value_of(entry: &Json) -> Val {
    let name = entry["name"].as_str().unwrap_or("?");
    match entry["type"].as_str() {
        Some("text") => Val::Str(entry["value"].as_str().expect("text value").to_owned()),
        Some("bool") => Val::Bool(entry["value"].as_bool().expect("bool value")),
        Some("int") => Val::I64(entry["value"].as_i64().expect("int value")),
        Some("bytes") => Val::Bytes(hex_decode(entry["hex"].as_str().expect("bytes hex"))),
        Some("datetime") => {
            let instant = DateTime::parse_from_rfc3339(entry["value"].as_str().expect("datetime value"))
                .unwrap_or_else(|e| panic!("fixture {name}: {e}"));
            Val::DateTime(instant.naive_utc())
        }
        other => panic!("fixture {name} has unknown type {other:?}"),
    }
}

fn hex_decode(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("fixture hex"))
        .collect()
}

#[test]
fn every_fixture_key_has_its_own_identity() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let fixture = fixture();
    let entries = fixture["keys"].as_array().expect("keys");
    let mut seen: Vec<(String, Key)> = Vec::new();
    for entry in entries {
        let name = entry["name"].as_str().expect("name").to_owned();
        let key = Key::of(&value_of(entry)).unwrap_or_else(|e| panic!("key {name}: {e}"));
        let again = Key::of(&value_of(entry)).expect("key again");
        assert_eq!(key, again, "key {name} has no stable identity");
        if let Some(same_as) = entry["same_as"].as_str() {
            let target = &seen.iter().find(|(n, _)| n == same_as).expect("same_as names an earlier key").1;
            assert_eq!(&key, target, "key {name} differs from {same_as}");
            continue;
        }
        for (other, other_key) in &seen {
            assert_ne!(other_key, &key, "keys {other} and {name} have the same identity");
        }
        seen.push((name, key));
    }
}

#[test]
fn a_null_key_is_codec_decode() {
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
