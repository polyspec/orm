//! The text of a JSON array of lines, each ended by LF, for the dbspec tests.

use serde_json::Value;

/// The text of a JSON array of lines, each ended by LF.
pub fn lines(value: &Value) -> String {
    value.as_array().expect("strings").iter().map(|l| format!("{}\n", l.as_str().expect("string"))).collect()
}
