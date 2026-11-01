//! The collection recipe, tests/collection/collection.json, on sqlite (docs/spec/feature-coverage.md FCV-3 and FCV-4).
//! Requirements: INT-30, INT-31, INT-32, INT-33, INT-35, INT-81, INT-82, INT-84.

use polyspec_orm_tests::recipe;

polyspec_orm::models!();

#[path = "common/collection_models.rs"]
mod collection_models;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials_with(
        "collection_sqlite",
        "tests/collection/collection.json",
        "sqlite",
        collection_models::BenchModels,
    ));
}
