//! The plan cases of tests/dbspec/plan-cases.json, each with its id and plan text (docs/spec/plans.md).

use crate::plan_recipe::recipe_cases;
use std::path::Path;

/// One plan case: its id and its plan text.
pub struct PlanCase {
    pub id: String,
    pub plan: String,
}

/// The cases of the plan-cases.json at `path` (tests/dbspec/plan-cases.json), in the recipe's order.
pub fn read_cases(path: &Path) -> Result<Vec<PlanCase>, String> {
    Ok(recipe_cases(path)?.into_iter().map(|(id, _, plan)| PlanCase { id, plan }).collect())
}
