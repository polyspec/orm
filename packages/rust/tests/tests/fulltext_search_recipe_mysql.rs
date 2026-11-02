//! Requirements: FCV-4, FCV-9, FCV-10, DSL-32, DSL-33, DIA-6, DIA-187, PRT-75.
//! The fulltext_search recipe, contracts/fixtures/fulltext_search/fulltext_search.json, on mysql (docs/spec/feature-coverage.md FCV-3, FCV-4).

use polyspec_orm_tests::recipe;

// The generated models of the bench set, as `crate::model`, which the dispatcher of the model ops calls (FCV-4).
polyspec_orm::models!();

#[path = "fulltext_search/dispatch.rs"]
mod dispatch;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials_with_models(
        "fulltext_search_recipe_mysql",
        "contracts/fixtures/fulltext_search/fulltext_search.json",
        "mysql",
        || dispatch::models(polyspec_orm::Dialect::MySql),
    ));
}
