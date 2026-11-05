//! Output of a model: the array output of a value that serde_json cannot represent,
//! such as the number 1e400, returns CODEC_ENCODE instead of stopping the process.

use polyspec_orm::{Core, Model, Val};

use crate::secret_config;
use secret_config::{Secret, SECRET};

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

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("model_output": array_output_of_an_unrepresentable_number_is_an_error)
}
