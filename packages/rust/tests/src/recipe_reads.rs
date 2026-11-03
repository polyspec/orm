//! The run-time read of a recipe step (FCV-4): a key of a step that the helper never reads asserts nothing, so a run
//! records what it reads and an unread key fails the case by name.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};

use serde_json::Value;

/// Keys that the format holds for the reader of the recipe or for the runner of the step, which no op reads.
const ANNOTATIONS: [&str; 4] = ["op", "only", "reason", "expect_unnamed"];

/// The keys read of each step, by the address of the step, which a recipe holds for the whole run of its case.
static READS: LazyLock<Mutex<HashMap<usize, HashSet<String>>>> = LazyLock::new(Mutex::default);
/// The step of each resolved copy that a helper reads in its place.
static COPIES: LazyLock<Mutex<HashMap<usize, usize>>> = LazyLock::new(Mutex::default);

fn address(step: &Value) -> usize {
    std::ptr::from_ref(step) as usize
}

/// Records the read of `key` and returns the step, so that the read keeps its form: `read(step, "x")["x"]`.
pub fn read<'a>(step: &'a Value, key: &str) -> &'a Value {
    let at = address(step);
    let at = COPIES.lock().unwrap().get(&at).copied().unwrap_or(at);
    READS.lock().unwrap().entry(at).or_default().insert(key.to_owned());
    step
}

/// Reads of `copy` count as reads of `step` until `forget_copy`.
pub fn copy_of(copy: &Value, step: &Value) {
    COPIES.lock().unwrap().insert(address(copy), address(step));
}

/// Ends what `copy_of` began; the address may hold another value after the copy goes.
pub fn forget_copy(copy: &Value) {
    COPIES.lock().unwrap().remove(&address(copy));
}

/// Fails by name on a key of the step that the run did not read.
pub fn check(step: &Value) -> Result<(), String> {
    let read = READS.lock().unwrap().remove(&address(step)).unwrap_or_default();
    let mut unread: Vec<&str> = step
        .as_object()
        .into_iter()
        .flatten()
        .map(|(key, _)| key.as_str())
        .filter(|key| !ANNOTATIONS.contains(key) && !read.contains(*key))
        .collect();
    if unread.is_empty() {
        return Ok(());
    }
    unread.sort_unstable();
    Err(format!("the helper did not read {} of {}", unread.join(", "), step["op"].as_str().unwrap_or_default()))
}

/// Fails by name on a key of the outcome of an expected error that no compare takes.
pub fn check_outcome(expected: Option<&Value>, op: &str, compared: &[&str]) -> Result<(), String> {
    let mut unread: Vec<String> = expected
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(key, _)| key.as_str())
        .filter(|key| !compared.contains(key))
        .map(|key| format!("expect.{key}"))
        .collect();
    if unread.is_empty() {
        return Ok(());
    }
    unread.sort_unstable();
    Err(format!("the helper did not read {} of {op}", unread.join(", ")))
}
