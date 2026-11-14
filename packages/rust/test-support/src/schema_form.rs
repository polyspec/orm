//! The refusals of a form of a JSON Schema of contracts/interface/flowmark, which the tests of the JSON forms of the
//! schema crate and of the JSON surface of polyspec-orm compare with no_refusal.

use serde_json::{json, Value};

/// What the form of the schema text `schema` refuses in `value`: its root form, or the form `#/$defs/<definition>`. One
/// line for each problem, none for a value of the form.
pub fn refusals(schema: &str, definition: Option<&str>, value: &Value) -> Vec<String> {
    let schema: Value = serde_json::from_str(schema).expect("a schema of contracts/interface/flowmark is JSON");
    let form = match definition {
        Some(definition) => json!({"$schema": schema["$schema"], "$ref": format!("#/$defs/{definition}"), "$defs": schema["$defs"]}),
        None => schema,
    };
    let validator = jsonschema::validator_for(&form).expect("the form is a JSON Schema");
    validator.iter_errors(value).map(|error| format!("{}: {error}", error.instance_path())).collect()
}

/// The refusals of a value of its form: none.
pub fn no_refusal() -> Vec<String> {
    Vec::new()
}
