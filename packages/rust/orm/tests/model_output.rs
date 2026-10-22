//! Output of a model: the JSON output writes an ordered-json value as its
//! text, and the array output of a value that serde_json cannot represent,
//! such as the number 1e400, returns CODEC_ENCODE instead of stopping the
//! process.


use polyspec_orm::{Core, Model, Val};

#[macro_use]
#[path = "common/model_row.rs"]
mod model_row;

#[path = "common/secret_config.rs"]
mod secret_config;
use secret_config::{Secret, SECRET};

#[test]
// The test of COD-27 (docs/spec).
fn array_output_of_an_unrepresentable_number_is_an_error() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let value = polyspec_orm::ordered_json::parse(r#"{"n":1e400}"#).unwrap();
    let mut row = Secret::from_core(Core::new(&SECRET));
    row.core_mut().set_ordered("config", value.clone());
    assert!(row.assign("config", Val::Ordered(value.clone())).unwrap());
    match polyspec_orm::model::to_array(&row) {
        Err(e) => assert_eq!(e.code(), "CODEC_ENCODE", "{e}"),
        Ok(v) => panic!("to_array returned {v}"),
    }
    match Val::Ordered(value).to_json() {
        Err(e) => assert_eq!(e.code(), "CODEC_ENCODE", "{e}"),
        Ok(v) => panic!("Val::to_json returned {v}"),
    }
}

#[test]
// The test of COD-16, COD-26 (docs/spec).
fn json_output_keeps_the_ordered_json_text() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for text in [r#"{"b":1,"a":[],"c":{},"n":1.50}"#, r#"{"n":1e400}"#] {
        let value = polyspec_orm::ordered_json::parse(text).unwrap();
        let mut row = Secret::from_core(Core::new(&SECRET));
        row.core_mut().set_ordered("config", value.clone());
        assert!(row.assign("config", Val::Ordered(value)).unwrap());
        assert_eq!(polyspec_orm::model::to_json(&row).unwrap(), format!(r#"{{"config":{{"kind":"value","value":{text}}}}}"#),);
    }
}
