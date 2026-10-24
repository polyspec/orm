//! Reads a shared dbspec vector file for schema test harnesses.

use crate::or_panic::OrPanic;
use serde_json::Value;

/// The versioned dbspec vector file at the repository path.
pub(super) fn vectors(name: &str) -> Value {
    let filename = format!("{name}.json");
    let path = polyspec_orm_testcase::manifest_dir().join(format!("../../../tests/dbspec/{filename}"));
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(&path).or_panic(|e| format!("{}: {e}", path.display()))).expect(&filename);
    assert_eq!(vectors["version"], 1, "tests/dbspec/{filename} version");
    vectors
}

/// Joins text lines with one trailing newline per line.
pub(super) fn lines(value: &Value) -> String {
    value.as_array().expect("lines").iter().map(|l| format!("{}\n", l.as_str().expect("line"))).collect()
}
