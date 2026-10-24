//! Joins JSON string arrays into the newline-terminated source used by dbspec vector tests.

use serde_json::Value;

pub fn text(lines: &Value) -> String {
    lines.as_array().unwrap().iter().map(|line| format!("{}\n", line.as_str().unwrap())).collect()
}
