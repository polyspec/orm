//! bind_vectors: the bind cases of tests/bind/vectors.json, checking parameter values against their slot's logical type (docs/spec/protocol.md
//! §5 "Parameters"). These are the same cases as Go's TestBindVectors. check_param is visible only inside the crate, so src/bind_check.rs makes this
//! file a unit test module.
use super::{check_assign, check_param, transform_param, ParamSlot};
use crate::db::Zone;
use crate::{Error, Param};
use base64::Engine as _;
use serde_json::Value;

/// A value of a bind case as the host value a Rust program passes: a JSON integer is `I64`, another number `F64`,
/// `{"int": text}` an `I64`, `{"f64": text}` a non-finite `F64` and `{"bytes": base64}` `Bytes`.
fn vector_value(v: &Value) -> Param {
    match v {
        Value::Null => Param::Null,
        Value::Bool(b) => Param::Bool(*b),
        Value::Number(n) => n.as_i64().map(Param::I64).unwrap_or_else(|| Param::F64(n.as_f64().unwrap())),
        Value::String(s) => Param::Str(s.clone()),
        Value::Object(o) if o.get("native") == Some(&Value::from("date")) => Param::Date(chrono::NaiveDate::from_ymd_opt(2024, 1, 2).unwrap()),
        Value::Object(o) if o.get("native") == Some(&Value::from("datetime")) => {
            Param::DateTime(chrono::NaiveDate::from_ymd_opt(2024, 1, 2).unwrap().and_hms_opt(3, 4, 5).unwrap())
        }
        Value::Object(o) if o.contains_key("int") => Param::I64(o["int"].as_str().unwrap().parse().unwrap()),
        Value::Object(o) if o.contains_key("f64") => Param::F64(match o["f64"].as_str().unwrap() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            _ => f64::NEG_INFINITY,
        }),
        Value::Object(o) if o.contains_key("bytes") => Param::Bytes(base64::engine::general_purpose::STANDARD.decode(o["bytes"].as_str().unwrap()).unwrap()),
        other => panic!("value {other} has no host form"),
    }
}

#[test]
fn bind_vectors() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let raw = std::fs::read_to_string(polyspec_orm_testcase::manifest_dir().join("../../../tests/bind/vectors.json")).unwrap();
    let vectors: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(vectors["zone"], "+00:00", "this runner checks in UTC");
    let cases = vectors["bind"].as_array().unwrap();
    assert!(!cases.is_empty(), "no bind cases");
    let mut failed = Vec::new();
    for c in cases {
        let name = c["name"].as_str().unwrap();
        // Rust has no native time value (Param has no time variant): a native time case has no Rust form.
        if c["value"].get("native") == Some(&Value::from("time")) {
            continue;
        }
        let s = &c["slot"];
        let slot = ParamSlot {
            ty: s["type"].as_str().unwrap(),
            precision: s["precision"].as_i64().unwrap_or(0),
            scale: s["scale"].as_i64().unwrap_or(0),
            length: s["length"].as_i64().unwrap_or(0),
            not_null: s["not_null"].as_bool().unwrap_or(false),
            column: "column",
        };
        let value = vector_value(&c["value"]);
        let got = match s["transform"].as_str() {
            Some(kind) => transform_param(kind, &value),
            None => check_assign(0, &value, &slot).and_then(|()| check_param(0, &value, &slot, &Zone)).map(|()| value.clone()),
        };
        let ok = match (&got, c.get("code")) {
            (Err(Error::Engine { code, .. }), Some(want)) => want == code.as_str(),
            (Ok(bound), None) => format!("{bound:?}") == format!("{:?}", vector_value(&c["bound"])),
            _ => false,
        };
        if !ok {
            failed.push(format!("{name}: check_param({value:?}) = {got:?}; want {}", c.get("code").unwrap_or(&c["bound"])));
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}
