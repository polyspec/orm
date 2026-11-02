//! The planner compile recipe, tests/planner/compile.json (FCV-3), through the public planner API `engine::compile`. Each case
//! of the recipe is the trial planner_compile_none::<id>: each planner.compile step builds its request from its JSON with the
//! manifest hash of the schema it names, compiles it for each dialect, and checks the plans with the expect of the none part,
//! or the error code of every dialect.
//! Requirements: PRT-6, PRT-13, PRT-14, PRT-16, PRT-17, PRT-20, PRT-21, PRT-22, PRT-23, PRT-25, PRT-31, PRT-32, PRT-33,
//! DSL-16, DSL-24, DSL-34, DSL-74, DSL-78, DSL-99, DSL-138, DSL-147, DSL-148, DIA-1, DIA-2, DIA-3, DIA-4, DIA-5, DIA-7,
//! DIA-8, DIA-9, DIA-12, DIA-13, DIA-18, DIA-22, DIA-23, DIA-24, DIA-27, DIA-31, DIA-35, COD-43, PRT-7, PRT-19, PRT-37,
//! PRT-67, PRT-78, DSL-95.

use polyspec_orm::engine::{compile, Dialect};
use polyspec_orm::plan::Step;
use polyspec_orm::{dbspec, ir, schema};
use serde_json::{json, Value};

#[path = "common/or_panic.rs"]
mod or_panic;

#[path = "unit/ir_request.rs"]
mod ir_request;

use ir_request::{repository, request, schema as manifest_of};

const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

/// One statement of a plan in the form of the planner fixture: its role, sql, bind slots and tables.
fn statement(step: &Step) -> Value {
    let slots: Vec<Value> = step
        .bind_slots
        .iter()
        .map(|slot| {
            if slot.from == "parent" {
                return json!({"from": slot.from, "key_types": slot.key_types});
            }
            let mut out = json!({"from": slot.from, "type": slot.col_type});
            if slot.from == "param" {
                out["param"] = json!(slot.param);
            }
            // A datetime or time slot carries its fraction digits.
            if slot.col_type == "datetime" || slot.col_type == "time" {
                out["precision"] = json!(slot.precision);
            }
            // A varchar param slot carries its length.
            if slot.from == "param" && slot.col_type == "varchar" {
                out["length"] = json!(slot.length);
            }
            // An assignment slot of a non-null column says so.
            if slot.not_null {
                out["not_null"] = json!(true);
            }
            out
        })
        .collect();
    json!({"role": step.role, "sql": step.sql, "slots": slots, "tables": step.tables})
}

/// The outcome of one planner.compile step: the statements of each dialect, or the error code that each dialect fails with.
fn check_step(case: &str, step: &Value) {
    assert_eq!(step["op"], "planner.compile", "{case}: the ops of this recipe are planner.compile");
    let at = format!("tests/planner/{}", step["schema"].as_str().expect("schema"));
    let manifest = manifest_of(&at);
    let input = request(&step["input"], &manifest.manifest_hash);
    let expect = &step["expect"]["none"];
    if let Some(want) = expect.get("error").and_then(Value::as_str) {
        for (name, dialect) in DIALECTS {
            let got = compile(&manifest, dialect, &input).err().map(|error| error.code().to_owned());
            assert_eq!(got.as_deref(), Some(want), "{case}: {name}");
        }
        return;
    }
    for (name, dialect) in DIALECTS {
        let plan = match compile(&manifest, dialect, &input) {
            Ok(plan) => plan,
            Err(error) => panic!("{case}: {name}: {error}"),
        };
        let got = Value::Array(plan.steps.iter().map(statement).collect());
        assert_eq!(got, expect["value"][name], "{case}: {name}");
    }
}

fn main() {
    let path = repository().join("tests/planner/compile.json");
    let recipe: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("compile.json")).expect("compile.json is JSON");
    let cases = recipe["cases"].as_array().expect("cases").clone();
    assert!(!cases.is_empty(), "compile.json has no cases");
    let trials: Vec<_> = cases
        .into_iter()
        .map(|case| {
            let id = case["id"].as_str().expect("id").to_owned();
            polyspec_orm_testcase::trial(format!("planner_compile_none::{id}"), polyspec_orm_testcase::COMPUTE, move || {
                for step in case["steps"].as_array().expect("steps") {
                    check_step(&id, step);
                }
            })
        })
        .collect();
    polyspec_orm_testcase::run(trials);
}
