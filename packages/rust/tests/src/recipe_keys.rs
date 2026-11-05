//! The key check of the recipe format (FCV-2 to FCV-4, T334-3-5-6): the Rust loader refuses a file, case or step key that the
//! key table beside the recipe's schema does not hold, and each op that the table does not hold, by name, before any case runs.

use serde_json::{Map, Value};
use std::path::Path;

/// The key table beside the schema that the `$schema` of the recipe at `path` names, relative to the recipe's directory.
fn key_table(path: &str, schema: &str) -> Result<Value, String> {
    let root = polyspec_orm_testcase::manifest_dir().join("../../..");
    let directory = Path::new(path).parent().unwrap_or(Path::new(""));
    let schema_directory = Path::new(schema).parent().unwrap_or(Path::new(""));
    let table = root.join(directory).join(schema_directory).join("recipe-keys.json");
    let text = std::fs::read_to_string(&table).map_err(|error| format!("recipe key table {}: {error}", table.display()))?;
    serde_json::from_str(&text).map_err(|error| format!("recipe key table {}: {error}", table.display()))
}

/// The keys that a list of a key table holds, as text.
fn held(keys: &Value) -> Vec<&str> {
    keys.as_array().map(|list| list.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}

/// The first key of `object`, in sorted order, that `keys` does not hold.
fn unknown_key(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    let mut names: Vec<&String> = object.keys().collect();
    names.sort();
    names.into_iter().find(|name| !keys.contains(&name.as_str())).cloned()
}

/// Refuses the recipe text at `path` (relative to the repository root) on its first key or op that its table does not hold.
pub fn check_keys(path: &str, text: &str) -> Result<(), String> {
    let recipe: Value = serde_json::from_str(text).map_err(|error| format!("recipe {path}: {error}"))?;
    let object = recipe.as_object().ok_or_else(|| format!("recipe {path}: not an object"))?;
    let schema = match object.get("$schema").and_then(Value::as_str) {
        Some(schema) if !schema.is_empty() => schema,
        _ => return Err(format!("recipe {path}: no $schema names the recipe key table")),
    };
    let table = key_table(path, schema)?;
    if let Some(key) = unknown_key(object, &held(&table["file"])) {
        return Err(format!("recipe {path}: unknown key {key}"));
    }
    let cases = object.get("cases").and_then(Value::as_array).ok_or_else(|| format!("recipe {path}: cases is not a list"))?;
    for case in cases {
        let case = case.as_object().ok_or_else(|| format!("recipe {path}: a case is not an object"))?;
        let id = case.get("id").and_then(Value::as_str).unwrap_or_default();
        if let Some(key) = unknown_key(case, &held(&table["case"])) {
            return Err(format!("recipe {path} case {id}: unknown key {key}"));
        }
        let steps = case.get("steps").and_then(Value::as_array).ok_or_else(|| format!("recipe {path} case {id}: steps is not a list"))?;
        for (index, step) in steps.iter().enumerate() {
            let step = step.as_object().ok_or_else(|| format!("recipe {path} case {id} step {index}: not an object"))?;
            let op = step.get("op").and_then(Value::as_str).unwrap_or_default();
            let Some(keys) = table["step"].get(op) else {
                return Err(format!("recipe {path} case {id} step {index}: unknown op {op}"));
            };
            if let Some(key) = unknown_key(step, &held(keys)) {
                return Err(format!("recipe {path} case {id} step {index} ({op}): unknown key {key}"));
            }
        }
    }
    Ok(())
}
