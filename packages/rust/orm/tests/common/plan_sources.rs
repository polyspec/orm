//! The source text of each plan case of tests/dbspec/plan-cases.json, keyed by case id (docs/spec/plans.md).

use crate::plan_recipe::recipe_cases;
use std::collections::BTreeMap;
use std::path::Path;

/// The source text of each case in `dir`, keyed by case id; None is an empty schema.
pub fn read_sources(dir: &Path) -> Result<BTreeMap<String, Option<String>>, String> {
    Ok(recipe_cases(dir)?.into_iter().map(|(id, source, _)| (id, source)).collect())
}
