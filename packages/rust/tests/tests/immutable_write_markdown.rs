//! The immutable_write recipe, contracts/fixtures/immutable_write/immutable_write.json, on markdown
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).
//! Requirements: DBS-84.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::table_trials(
        "immutable_write_markdown",
        "contracts/fixtures/immutable_write/immutable_write.json",
        "contracts/fixtures/immutable_write/dbspec-set.json",
        "markdown",
    ));
}
