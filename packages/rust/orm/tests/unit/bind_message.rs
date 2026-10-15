//! bind_message: tests/bind/vectors.json의 message case, IR executor message parameter의 runtime value model JSON
//! 이다(docs/protocol.md §5 "Parameters"). Go의 TestBindMessageVectors와 같은 case다. markdown_param은 crate 안에서만
//! 보이므로 src/markdown.rs가 이 file을 unit test module로 둔다.
use super::markdown_param;
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
