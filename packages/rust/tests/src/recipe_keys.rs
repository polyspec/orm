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

#[cfg(test)]
mod tests {
    use super::check_keys;

    // A recipe at a path whose $schema is the recipe schema of this checkout, so the key table beside it is read.
    const PATH: &str = "contracts/fixtures/model_writes/model_writes.json";
    const SCHEMA: &str = "../../../scripts/features/schema/recipe.schema.json";
    const STEP: &str = r#"{"op": "dsn.connect", "dsn": "case"}"#;

    /// A recipe with the file keys `file`, the case keys `case` (each ending in a comma when not empty) and one step `step`.
    fn recipe(file: &str, case: &str, step: &str) -> String {
        format!(r#"{{"$schema": "{SCHEMA}", {file}"cases": [{{"id": "case-under-test", {case}"steps": [{step}]}}]}}"#)
    }

    #[test]
    fn a_recipe_whose_keys_the_table_holds_is_accepted() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        assert_eq!(check_keys(PATH, &recipe("", "", STEP)), Ok(()));
    }

    #[test]
    fn an_unknown_file_key_is_refused_by_name() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let error = check_keys(PATH, &recipe(r#""bogus": 1, "#, "", STEP)).unwrap_err();
        assert_eq!(error, format!("recipe {PATH}: unknown key bogus"));
    }

    #[test]
    fn an_unknown_case_key_is_refused_by_name_with_its_case() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let error = check_keys(PATH, &recipe("", r#""bogus": 1, "#, STEP)).unwrap_err();
        assert_eq!(error, format!("recipe {PATH} case case-under-test: unknown key bogus"));
    }

    #[test]
    fn an_unknown_op_is_refused_by_name_with_its_step() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let error = check_keys(PATH, &recipe("", "", r#"{"op": "no.such.op"}"#)).unwrap_err();
        assert_eq!(error, format!("recipe {PATH} case case-under-test step 0: unknown op no.such.op"));
    }

    #[test]
    fn a_step_key_another_op_holds_is_refused_on_the_op_that_does_not_hold_it() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let step = r#"{"op": "dsn.connect", "dsn": "case", "pool_size": 2}"#;
        let error = check_keys(PATH, &recipe("", "", step)).unwrap_err();
        assert_eq!(error, format!("recipe {PATH} case case-under-test step 0 (dsn.connect): unknown key pool_size"));
    }

    #[test]
    fn a_recipe_with_no_schema_is_refused_since_it_names_no_key_table() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let error = check_keys(PATH, r#"{"cases": []}"#).unwrap_err();
        assert_eq!(error, format!("recipe {PATH}: no $schema names the recipe key table"));
    }
}
