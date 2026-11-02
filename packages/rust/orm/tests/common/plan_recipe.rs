//! The steps of the cases of tests/dbspec/plan-cases.json, for the plan case loaders of the orm tests and the apply example.

use serde_json::Value;
use std::path::Path;

/// Joins a JSON array of lines, each ended by LF.
fn joined(value: &Value) -> Result<String, String> {
    let lines = value.as_array().ok_or_else(|| format!("{value} is not an array of lines"))?;
    lines.iter().map(|line| line.as_str().map(|l| format!("{l}\n")).ok_or_else(|| format!("{line} is not a line"))).collect()
}

/// The id, source (None for an empty schema) and plan text of each case of the plan-cases.json at `path`
/// (tests/dbspec/plan-cases.json).
pub fn recipe_cases(path: &Path) -> Result<Vec<(String, Option<String>, String)>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let recipe: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let cases = recipe["cases"].as_array().ok_or("plan-cases.json has no cases")?;
    cases
        .iter()
        .map(|case| {
            let id = case["id"].as_str().ok_or("plan case without an id")?.to_owned();
            let steps = case["steps"].as_array().ok_or_else(|| format!("{id}: no steps"))?;
            let source = steps.iter().find(|s| s["op"] == "dbspec.parse").map(|s| joined(&s["lines"])).transpose()?;
            let plan_step = steps.iter().find(|s| s["op"] == "dbspec.parse_plan").ok_or_else(|| format!("{id}: no dbspec.parse_plan step"))?;
            let plan = joined(&plan_step["lines"])?;
            Ok((id, source, plan))
        })
        .collect()
}
