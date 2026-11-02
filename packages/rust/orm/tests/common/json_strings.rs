//! The strings of a JSON array of strings, for the dbspec tests.

use serde_json::Value;

/// The strings of a JSON array of strings.
pub fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("strings").iter().map(|s| s.as_str().expect("string").to_owned()).collect()
}
