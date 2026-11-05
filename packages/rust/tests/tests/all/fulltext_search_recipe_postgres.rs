//! Requirements: FCV-4, FCV-9, FCV-10, DSL-32, DSL-33, DIA-6, DIA-187, PRT-75.
//! The fulltext_search recipe, contracts/fixtures/fulltext_search/fulltext_search.json, on postgres (docs/spec/feature-coverage.md FCV-3, FCV-4).

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::database_trials_with_models("fulltext_search_recipe_postgres", "contracts/fixtures/fulltext_search/fulltext_search.json", "postgres", || {
        crate::fulltext_dispatch::models(polyspec_orm::Dialect::Postgres)
    })
}
