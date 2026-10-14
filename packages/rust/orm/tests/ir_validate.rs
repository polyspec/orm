//! The shared validation vectors (tests/ir/validate.json) through the public planner API `engine::validate`, one
//! libtest-mimic trial per case (`validate_vectors::<name>`): each request, with the schema's manifest hash, is accepted
//! or fails with its expected code.

use polyspec_orm::engine::validate;
use polyspec_orm::{dbspec, ir, schema};
use serde_json::Value;

#[path = "unit/ir_request.rs"]
mod ir_request;

use ir_request::{repository, request, schema as manifest_of, REJECTED};

fn validate_case(case: &Value) {
    let name = case["name"].as_str().expect("name");
    let manifest = manifest_of("schema/bench.dbs");
    // A typed request cannot hold a member of an unknown type, so building it is the IR_INVALID refusal (REJECTED).
    let built = std::panic::catch_unwind(|| request(&case["request"], &manifest.manifest_hash));
    let got: Result<(), String> = match built {
        Ok(r) => validate(&manifest, &r).map_err(|e| e.code().to_owned()),
        Err(payload) => {
            let message = payload.downcast_ref::<String>().cloned().unwrap_or_default();
            match message.strip_prefix(REJECTED) {
                Some(_) => Err("IR_INVALID".to_owned()),
                None => std::panic::resume_unwind(payload),
            }
        }
    };
    match (&got, case["valid"].as_bool().unwrap_or(false), case["error"].as_str()) {
        (Ok(()), true, None) => {}
        (Err(code), false, Some(want)) if code == want => {}
        _ => panic!("{name}: got {got:?}, want {}", case.get("error").cloned().unwrap_or(Value::from("valid"))),
    }
}

fn main() {
    let path = repository().join("tests/ir/validate.json");
    let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("validate.json")).expect("validate.json is JSON");
    assert_eq!(file["schema"], "schema/bench.dbs", "validate.json schema");
    let cases = file["cases"].as_array().expect("cases").clone();
    assert!(!cases.is_empty(), "validate.json has no cases");
    let trials = cases
        .into_iter()
        .map(|case| {
            let name = case["name"].as_str().expect("name").to_owned();
            polyspec_orm_testcase::trial(format!("validate_vectors::{name}"), polyspec_orm_testcase::COMPUTE, move || validate_case(&case))
        })
        .collect();
    polyspec_orm_testcase::run(trials);
}
