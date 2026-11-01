//! The request validation recipe, tests/ir/validate.json (FCV-3), through the public planner API `engine::validate`. Each case
//! of the recipe is the trial ir_validate_none::<id>: each ir.validate step builds its request from its JSON with the schema's
//! manifest hash, and checks that the request is accepted or fails with its expected code. The recipe is read by this module
//! because the request builder it needs (unit/ir_request.rs) is shared only with the engine's unit tests.
//! Requirements: INT-24, PRT-4, PRT-6, PRT-8, PRT-10, PRT-12, PRT-14, PRT-16, PRT-17, PRT-18, PRT-20, PRT-21, PRT-22, PRT-24, PRT-78,
//! DBS-59, DBS-113, DSL-113, DSL-128.

use polyspec_orm::engine::validate;
use polyspec_orm::{dbspec, ir, schema};
use serde_json::Value;

#[path = "common/or_panic.rs"]
mod or_panic;

#[path = "unit/ir_request.rs"]
mod ir_request;

use ir_request::{repository, request, schema as manifest_of, REJECTED};

/// The outcome of one ir.validate step: its request is built (a request shape that the typed request refuses is IR_INVALID),
/// then validated; the expect of the none part is {error: CODE}, or {value: {bool: true}} for an accepted request.
fn check_step(case: &str, step: &Value, manifest: &schema::Manifest) {
    assert_eq!(step["op"], "ir.validate", "{case}: the ops of this recipe are ir.validate");
    assert!(step["request"].get("manifest_hash").is_none(), "{case}: request already holds manifest_hash");
    let built = std::panic::catch_unwind(|| request(&step["request"], &manifest.manifest_hash));
    let got: Result<(), String> = match built {
        Ok(r) => validate(manifest, &r).map_err(|e| e.code().to_owned()),
        Err(payload) => {
            let message = payload.downcast_ref::<String>().cloned().unwrap_or_default();
            match message.strip_prefix(REJECTED) {
                Some(_) => Err("IR_INVALID".to_owned()),
                None => std::panic::resume_unwind(payload),
            }
        }
    };
    let expect = &step["expect"]["none"];
    match expect.get("error").and_then(Value::as_str) {
        Some(want) => assert!(got.as_ref().err().is_some_and(|code| code == want), "{case}: got {got:?}, want {want}"),
        None => {
            assert_eq!(expect["value"], serde_json::json!({"bool": true}), "{case}: ir.validate expects {{bool true}} or an error");
            assert!(got.is_ok(), "{case}: got {got:?}, want valid");
        }
    }
}

/// Requirements: PRT-1.
/// A request whose manifest hash differs from the model's fails with SCHEMA_HASH_MISMATCH.
fn manifest_hash_mismatch() {
    let manifest = manifest_of("contracts/fixtures/bench/bench.dbs");
    let other = format!("sha256:{}", "0".repeat(64));
    assert_ne!(other, manifest.manifest_hash, "the other hash differs from the model's");
    let r = request(&serde_json::json!({"ir_version": 1, "n_params": 0, "kind": "all", "entity": "author"}), &other);
    let got = validate(&manifest, &r).map_err(|e| e.code().to_owned());
    assert_eq!(got, Err("SCHEMA_HASH_MISMATCH".to_owned()), "a request of another manifest");
}

fn main() {
    let path = repository().join("tests/ir/validate.json");
    let recipe: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("validate.json")).expect("validate.json is JSON");
    assert_eq!(recipe["schema"], "../../contracts/fixtures/bench/bench.dbs", "validate.json schema");
    let cases = recipe["cases"].as_array().expect("cases").clone();
    assert!(!cases.is_empty(), "validate.json has no cases");
    let mut trials: Vec<_> = vec![polyspec_orm_testcase::trial("manifest_hash_mismatch".to_owned(), polyspec_orm_testcase::COMPUTE, manifest_hash_mismatch)];
    trials.extend(cases.into_iter().map(|case| {
        let id = case["id"].as_str().expect("id").to_owned();
        polyspec_orm_testcase::trial(format!("ir_validate_none::{id}"), polyspec_orm_testcase::COMPUTE, move || {
            let manifest = manifest_of("contracts/fixtures/bench/bench.dbs");
            for step in case["steps"].as_array().expect("steps") {
                check_step(&id, step, &manifest);
            }
        })
    }));
    polyspec_orm_testcase::run(trials);
}
