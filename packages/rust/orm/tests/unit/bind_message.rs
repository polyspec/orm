//! bind_message: the message cases of tests/bind/vectors.json, the runtime value model JSON of IR executor message parameters
//! (docs/protocol.md §5 "Parameters"). These are the same cases as Go's TestBindMessageVectors. markdown_param is visible only inside the crate
//! , so src/markdown.rs makes this file a unit test module.
use super::{begin_message, markdown_param};
use crate::db::Zone;
use crate::engine::ParamUse;
use crate::{Error, Param};

#[test]
fn message_vectors() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let raw = std::fs::read_to_string(polyspec_orm_testcase::manifest_dir().join("../../../tests/bind/vectors.json")).unwrap();
    let vectors: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(vectors["zone"], "+00:00", "this runner writes in UTC");
    let mut failed = Vec::new();
    for c in vectors["message"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let value = Param::Str(c["value"].as_str().unwrap().to_owned());
        let slot = ParamUse { ty: c["type"].as_str().unwrap().to_owned(), column: None, assign: false };
        let got = markdown_param(0, &value, Some(&slot), "", &Zone);
        let ok = match (&got, c.get("code")) {
            (Err(Error::Engine { code, .. }), Some(want)) => want == code.as_str(),
            (Ok(json), None) => json == &c["json"],
            _ => false,
        };
        if !ok {
            failed.push(format!("{name}: markdown_param({value:?}) = {got:?}; want {}", c.get("code").unwrap_or(&c["json"])));
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

/// The control cases of tests/bind/vectors.json: the begin control message of a transaction with and without its
/// read_only option (docs/protocol.md §5 "Session").
#[test]
fn control_vectors() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let raw = std::fs::read_to_string(polyspec_orm_testcase::manifest_dir().join("../../../tests/bind/vectors.json")).unwrap();
    let vectors: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let cases = vectors["control"].as_array().expect("tests/bind/vectors.json has control cases");
    assert!(!cases.is_empty(), "tests/bind/vectors.json has no control cases");
    for c in cases {
        let read_only = c["read_only"].as_bool().unwrap();
        let got = serde_json::to_value(begin_message(read_only)).unwrap();
        assert_eq!(got, c["json"], "control/{}", c["name"]);
    }
}
