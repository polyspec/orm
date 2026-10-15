//! The shared codec vectors through the public codec API (`polyspec_orm::codec`), one libtest-mimic trial per case:
//! tests/codec/vectors.json (`vectors::<name>`), tests/codec/decode-vectors.json (`decode_vectors::<name>`) and
//! contracts/fixtures/styled_column_states.json (`styled_column_state_fixture::<id>`).
//!
//! When ORM_CODEC_OUT names a directory (make codec-check), the trial `vectors_output`, which runs after the vector
//! trials, writes Rust's encodings to rust.json there for the PHP cross-check, through a temporary file and a rename.

use std::sync::{Mutex, PoisonError};

use base64::Engine as _;
use polyspec_orm::codec::{decode, encode, encode_ordered, hex_decode, host_decode, host_encode};
use polyspec_orm::codes::CODEC_DECODE;
use polyspec_orm::{ordered_json, Param, StyledValue, Val};
use polyspec_orm_testcase::Trial;
use serde_json::{Map, Value};

#[derive(serde::Deserialize, Clone)]
struct Vector {
    name: String,
    styles: Vec<String>,
    value: Value,
    encoded_b64: Option<String>,
    #[serde(default)]
    deterministic: bool,
    /// The code that encoding `value` must fail with; such a vector has no stored cell.
    encode_error: Option<String>,
}

/// The encodings of the codec vectors, by name, for ORM_CODEC_OUT.
static OUTPUT: Mutex<Option<Map<String, Value>>> = Mutex::new(None);

fn root() -> std::path::PathBuf {
    polyspec_orm_testcase::manifest_dir().join("../../..")
}

/// The serde_json form of an ordered-json value, from its compact text.
fn ordered_json_value(value: &ordered_json::Value) -> Option<Value> {
    serde_json::from_str(&value.compact()).ok()
}

/// JSON cannot distinguish 2.0 from 2: compare with integral floats folded to integers.
fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.as_i64().is_none() && f.fract() == 0.0 && f.abs() < 9.0e15 => Value::from(f as i64),
            _ => v.clone(),
        },
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), norm(x))).collect()),
        _ => v.clone(),
    }
}

/// The JSON value a decoded cell stands for, for comparison with a vector's `value`; a cell kind that has no JSON
/// form is `None`.
fn json_of(val: &Val) -> Option<Value> {
    match val {
        Val::Null => Some(Value::Null),
        Val::Str(s) => Some(Value::String(s.clone())),
        Val::Json(j) => Some(j.clone()),
        Val::Ordered(o) => ordered_json_value(o),
        _ => None,
    }
}

/// Each vector of tests/codec/vectors.json: it decodes to its value, a deterministic style re-encodes to the same
/// bytes, and the encoding decodes back to the value.
fn vectors() -> Vec<Trial> {
    let src = std::fs::read(root().join("tests/codec/vectors.json")).expect("vectors.json");
    let f: Map<String, Value> = serde_json::from_slice(&src).unwrap();
    let mut vectors: Vec<Vector> = serde_json::from_value(f["vectors"].clone()).unwrap();
    for v in &mut vectors {
        // codec vector의 `json` stage는 dbspec의 `ordered_json` stage다.
        for style in &mut v.styles {
            if style == "json" || style == "jsons" {
                *style = "ordered_json".into();
            }
        }
    }
    vectors.into_iter().map(|v| polyspec_orm_testcase::trial(format!("vectors::{}", v.name), polyspec_orm_testcase::COMPUTE, move || vector_case(&v))).collect()
}

fn vector_case(v: &Vector) {
    if let Some(code) = &v.encode_error {
        let styles: Vec<&str> = v.styles.iter().map(String::as_str).collect();
        // A list of host stages only (ip) encodes with `host_encode` and no key.
        let host = v.styles.iter().all(|s| s == "aes" || s == "hex" || s == "ip");
        let got = match &v.value {
            Value::String(text) if host => host_encode(&Param::Str(text.clone()), &v.styles, ""),
            _ => encode(&styles, StyledValue::Value(&v.value)),
        };
        match got {
            Err(e) if e.code() == code => return,
            other => panic!("{}: encode gave {other:?}, want {code}", v.name),
        }
    }
    let mut fails = Vec::new();
    let raw = match &v.encoded_b64 {
        None => Val::Null,
        Some(b) => Val::Bytes(base64::engine::general_purpose::STANDARD.decode(b).unwrap()),
    };
    let decoded = decode(&v.styles, &raw);
    if matches!(raw, Val::Null) != matches!(decoded, Ok(Val::Null)) {
        fails.push("SQL NULL state changed during decode".to_owned());
    }
    let got = match &decoded {
        Ok(Val::Json(j)) => j.clone(),
        Ok(Val::Ordered(o)) => ordered_json_value(o).expect("the ordered-json value has a serde_json form"),
        Ok(Val::Str(s)) => Value::String(s.clone()),
        Ok(Val::Null) => Value::Null,
        other => panic!("{}: decode {other:?}", v.name),
    };
    if norm(&got) != norm(&v.value) {
        fails.push(format!("decoded {got} want {}", v.value));
    }
    let styles: Vec<&str> = v.styles.iter().map(String::as_str).collect();
    let enc = match &decoded {
        Ok(Val::Null) => encode(&styles, StyledValue::SqlNull).unwrap(),
        Ok(Val::Ordered(o)) => encode_ordered(&styles, StyledValue::Value(o)).unwrap(),
        _ => encode(&styles, StyledValue::Value(&got)).unwrap(),
    };
    let enc_b64 = match &enc {
        Param::Null => None,
        Param::Str(s) => Some(base64::engine::general_purpose::STANDARD.encode(s.as_bytes())),
        Param::Bytes(b) => Some(base64::engine::general_purpose::STANDARD.encode(b)),
        other => panic!("encode gave {other:?}"),
    };
    OUTPUT
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get_or_insert_with(Map::new)
        .insert(v.name.clone(), enc_b64.clone().map(Value::String).unwrap_or(Value::Null));
    if v.deterministic && enc_b64 != v.encoded_b64 {
        fails.push(format!("encoded {enc_b64:?} want {:?}", v.encoded_b64));
    }
    let back_raw = match enc {
        Param::Null => Val::Null,
        Param::Str(s) => Val::Str(s),
        Param::Bytes(b) => Val::Bytes(b),
        other => panic!("encode gave {other:?}"),
    };
    match decode(&v.styles, &back_raw) {
        Ok(Val::Json(j)) if norm(&j) == norm(&v.value) => {}
        Ok(Val::Str(s)) if v.value.as_str() == Some(s.as_str()) => {}
        Ok(Val::Ordered(o)) if ordered_json_value(&o).is_some_and(|j| norm(&j) == norm(&v.value)) => {}
        Ok(Val::Null) if v.value.is_null() => {}
        other => fails.push(format!("round trip {other:?}")),
    }
    assert!(fails.is_empty(), "{}: {}", v.name, fails.join("; "));
}

/// Writes the encodings of the vector trials to ORM_CODEC_OUT/rust.json when the variable names a directory.
fn vectors_output() {
    let Some(dir) = std::env::var_os("ORM_CODEC_OUT") else { return };
    let out = OUTPUT.lock().unwrap_or_else(PoisonError::into_inner).take().unwrap_or_default();
    let dir = std::path::PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("ORM_CODEC_OUT directory");
    let temporary = dir.join(format!("rust.json.tmp-{}", std::process::id()));
    std::fs::write(&temporary, serde_json::to_string_pretty(&Value::Object(out)).unwrap()).expect("rust.json");
    std::fs::rename(&temporary, dir.join("rust.json")).expect("rust.json rename");
}

/// Each vector of tests/codec/decode-vectors.json: a stored cell decodes only in the form the encoder writes, and
/// any other form is CODEC_DECODE. A style list without aes of host stages reads with `host_decode` and no key, the
/// rest with `decode`.
fn decode_vectors() -> Vec<Trial> {
    let src = std::fs::read(root().join("tests/codec/decode-vectors.json")).expect("decode-vectors.json");
    let f: Value = serde_json::from_slice(&src).unwrap();
    let vectors = f["vectors"].as_array().expect("vectors");
    assert!(!vectors.is_empty(), "decode-vectors.json has no vectors");
    vectors
        .iter()
        .map(|v| {
            let name = v["name"].as_str().unwrap().to_owned();
            let v = v.clone();
            polyspec_orm_testcase::trial(format!("decode_vectors::{name}"), polyspec_orm_testcase::COMPUTE, move || decode_vector_case(&v))
        })
        .collect()
}

fn decode_vector_case(v: &Value) {
    let name = v["name"].as_str().unwrap();
    let styles: Vec<String> = v["styles"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_owned()).collect();
    let raw = match (v["stored"].as_str(), v["stored_hex"].as_str()) {
        (Some(text), _) => Val::Str(text.to_owned()),
        (None, Some(hex)) => Val::Bytes(hex_decode(&hex.to_ascii_uppercase()).unwrap()),
        _ => panic!("{name}: no stored cell"),
    };
    let host = styles.iter().all(|s| s == "hex" || s == "ip");
    let got = if host { host_decode(&raw, &styles, "") } else { decode(&styles, &raw) };
    match (&got, v["error"].as_str(), v.get("value")) {
        (Err(e), Some(code), _) if e.code() == code => {}
        (Ok(val), None, Some(want)) if json_of(val).as_ref() == Some(want) => {}
        _ => panic!("{name}: got {got:?}, want {}", v.get("error").or(v.get("value")).unwrap()),
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
    // fixture의 `json`과 `jsons` stage는 dbspec의 `ordered_json` stage다.
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
    let decoded = decoded.unwrap_or_else(|error| panic!("{id}: {error}"));
    let expected = &case["output"];
    let output = match &decoded {
        Val::Null => serde_json::json!({"kind": "sql-null"}),
        Val::Ordered(value) => serde_json::json!({"kind": "value", "value": ordered_json_value(value).unwrap()}),
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
    let mut trials = vectors();
    trials.push(polyspec_orm_testcase::trial("vectors_output", polyspec_orm_testcase::COMPUTE, vectors_output));
    trials.extend(decode_vectors());
    trials.extend(styled_column_state_fixture());
    // vectors_output reads what the vector trials before it wrote, so the trials run in file order.
    polyspec_orm_testcase::run_in_order(trials);
}
