// The core runs the cases of its interface contract that need a database server (docs/spec/service-state.md SVC-7,
// binding GN-13j): the groups of contracts/interface/service.json that `cases` of packages/rust/interface.json names.
// Each case names a service of `services`; the test reads the address of the service from its variable, runs the state
// program of `state` with `setup` before it makes the receiver and the arguments, replaces each `{"service": "address"}`
// by the address and each `{"service": "scope"}` by the scope `rust:<member>:<case id>:`, runs the case as
// the_core_passes_the_cases_of_its_contract runs it, and then runs the program with `check`.

use std::io::Write as _;
use std::process::{Command, Stdio};

use serde_json::{Map, Value};

use crate::interface_cases::run_case;

const CONTRACT: &str = include_str!("../../interface.json");
const CASES: &str = include_str!("../../../../contracts/interface/service.json");
const FILE: &str = "contracts/interface/service.json";

/// The value of a variable that a service names: a variable that is not set or is empty fails the case (GN-13j).
fn variable(name: &str, service: &str) -> Result<String, String> {
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => Ok(value),
        _ => Err(format!("the service {service} needs the variable {name}; run make interface-service-cases-rust, which reads the servers of make orm-test-servers")),
    }
}

/// Replaces each `{"service": "address"}` and `{"service": "scope"}` of a case value.
fn resolve(value: &Value, address: &str, scope: &str) -> Value {
    match value {
        Value::Object(object) if object.len() == 1 && object.contains_key("service") => match object["service"].as_str() {
            Some("address") => Value::from(address),
            Some("scope") => Value::from(scope),
            other => panic!("a service value is address or scope, not {other:?}"),
        },
        Value::Object(object) => Value::Object(object.iter().map(|(key, value)| (key.clone(), resolve(value, address, scope))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(|item| resolve(item, address, scope)).collect()),
        other => other.clone(),
    }
}

/// Runs the state program with `step`, the scope and the JSON text of `input`, and waits for its exit with no time limit.
fn state(program: &str, step: &str, scope: &str, input: &Value) -> Result<(), String> {
    let mut child = Command::new(program)
        .args([step, scope])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("{step}: the state program {program} did not start: {error}"))?;
    child
        .stdin
        .take()
        .expect("the state program has a standard input")
        .write_all(input.to_string().as_bytes())
        .map_err(|error| format!("{step}: writing the input of the state program failed: {error}"))?;
    let output = child.wait_with_output().map_err(|error| format!("{step}: waiting for the state program failed: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{step}: the state program exited with {}: {}{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

/// Runs one case of a service group and adds each failure to `failures`.
async fn run_service_case(member: &str, case: &Value, services: &[Value], failures: &mut Vec<String>) {
    let fields = case.as_object().unwrap_or_else(|| panic!("{member}: a case is an object"));
    let id = fields.get("id").and_then(Value::as_str).unwrap_or_else(|| panic!("{member}: a case has an id"));
    let what = format!("{member} {id}");
    let service = fields.get("service").and_then(Value::as_object).unwrap_or_else(|| panic!("{what}: a case of {FILE} names its service"));
    for key in service.keys() {
        assert!(["id", "setup", "check"].contains(&key.as_str()), "{what}: a service has no key {key}");
    }
    let name = service.get("id").and_then(Value::as_str).unwrap_or_else(|| panic!("{what}: the service names its id"));
    let declared = services
        .iter()
        .find(|declared| declared["id"].as_str() == Some(name))
        .unwrap_or_else(|| panic!("{what}: the contract declares no service {name}"));
    let address = match variable(declared["address"].as_str().unwrap_or_else(|| panic!("{name}: the service names its address")), name) {
        Ok(address) => address,
        Err(error) => {
            failures.push(format!("{what}: {error}"));
            return;
        }
    };
    let scope = format!("rust:{member}:{id}:");
    let program = || -> Result<String, String> {
        let state = declared["state"].as_str().ok_or_else(|| format!("the service {name} declares no state program"))?;
        variable(state, name)
    };
    if let Some(setup) = service.get("setup") {
        if let Err(error) = program().and_then(|program| state(&program, "setup", &scope, setup)) {
            failures.push(format!("{what}: {error}"));
            return;
        }
    }
    let mut plain: Map<String, Value> = fields.iter().filter(|(key, _)| key.as_str() != "service").map(|(key, value)| (key.clone(), value.clone())).collect();
    plain = resolve(&Value::Object(plain), &address, &scope).as_object().expect("a resolved case is an object").clone();
    run_case(member, &Value::Object(plain), failures).await;
    if let Some(check) = service.get("check") {
        if let Err(error) = program().and_then(|program| state(&program, "check", &scope, check)) {
            failures.push(format!("{what}: {error}"));
        }
    }
}

// Requirements: SVC-1, SVC-2, SVC-4, SVC-6, SVC-7. Run by make interface-service-cases-rust with the servers of the run.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the database servers of make orm-test-servers; make interface-service-cases-rust runs it"]
async fn the_core_passes_the_service_cases_of_its_contract() {
    let _case = polyspec_orm_testcase::case!();
    let contract: Value = serde_json::from_str(CONTRACT).expect("packages/rust/interface.json is JSON");
    let cases: Value = serde_json::from_str(CASES).expect("contracts/interface/service.json is JSON");
    let services = contract["services"].as_array().expect("the contract declares its services");
    let mut ran = 0usize;
    let mut failures = Vec::new();
    for row in contract["cases"].as_array().expect("the contract has cases") {
        if row["file"].as_str() != Some(FILE) {
            continue;
        }
        let only = row["only"]["targets"].as_array().unwrap_or_else(|| panic!("{row}: a row of {FILE} has an only (SVC-2)"));
        assert!(!only.iter().any(|target| target == "wasm"), "{row}: a row of {FILE} leaves wasm out (SVC-2)");
        let member = row["member"].as_str().unwrap_or_else(|| panic!("{row}: a row of {FILE} names a member"));
        let name = row["group"].as_str().expect("a row of cases names its group");
        let group = cases[name].as_array().unwrap_or_else(|| panic!("{FILE} has no group {name}"));
        assert!(!group.is_empty(), "the group {name} holds no case");
        for case in group {
            run_service_case(member, case, services, &mut failures).await;
            ran += 1;
        }
    }
    assert!(ran > 0, "the contract names no group of {FILE}");
    polyspec_orm_testcase::step(format_args!("ran {ran} cases of {FILE}"));
    assert!(failures.is_empty(), "{} of {ran} cases failed:\n{}", failures.len(), failures.join("\n"));
}
