//! The physical steps of tests/dbspec/plans-physical.json, keyed by case id, before and after each plan runs (dbspec_plan_apply.rs).

use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

/// The physical steps of one case, before and after its plan runs (JSON arrays).
pub struct Physical {
    pub before: Value,
    pub after: Value,
}

/// The physical records of tests/dbspec/plans-physical.json in `dir`, keyed by case id.
pub fn read_physical(dir: &Path) -> Result<BTreeMap<String, Physical>, String> {
    let path = dir.join("plans-physical.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let file: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let cases = file["cases"].as_object().ok_or("plans-physical.json has no cases")?;
    Ok(cases.iter().map(|(id, case)| (id.clone(), Physical { before: case["before"].clone(), after: case["after"].clone() })).collect())
}
