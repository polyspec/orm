//! Loads one feature fixture case and reports the CPU and wall time of its assertion body.

use polyspec_orm_case_clock::CaseClock;
use polyspec_orm_testcase::OrPanic;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

pub const CPU_LIMIT: Duration = Duration::from_secs(10);

/// Finds one fixture case, verifies its feature and operation, and returns its input and expected values.
pub fn case(path: &Path, feature: &str, id: &str, operation: &str) -> (Value, Value) {
    let text = std::fs::read_to_string(path).or_panic(|error| format!("{}: {error}", path.display()));
    let fixture: Value = serde_json::from_str(&text).or_panic(|error| format!("{}: {error}", path.display()));
    assert_eq!(fixture["feature"], feature, "{}: feature", path.display());
    let cases: Vec<&Value> = fixture["cases"].as_array().expect("fixture cases").iter().filter(|case| case["id"] == id).collect();
    let [case] = cases.as_slice() else { panic!("{}: case {id} appears {} times", path.display(), cases.len()) };
    assert_eq!(case["operation"], operation, "{id}: operation");
    (case["input"].clone(), case["expected"].clone())
}

/// Runs `body`, reports progress and elapsed time, and warns if the CPU limit is exceeded.
pub fn run(id: &str, body: impl FnOnce()) {
    let clock = CaseClock::start();
    polyspec_orm_testcase::step(format_args!("start {id}"));
    body();
    let cpu = clock.cpu();
    if cpu >= CPU_LIMIT {
        polyspec_orm_testcase::warning(format_args!("{id}: used {cpu:?} of CPU time, limit {CPU_LIMIT:?}"));
    }
    polyspec_orm_testcase::step(format_args!("{id} cpu={cpu:?} wall={:?}", clock.wall()));
}
