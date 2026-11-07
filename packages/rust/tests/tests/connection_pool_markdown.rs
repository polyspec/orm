//! Requirements: CFG-4, CFG-5, CFG-5a, PRT-77.
//! The connection_pool recipe, contracts/fixtures/connection_pool/connection_pool.json, on markdown (docs/spec/feature-coverage.md FCV-3).

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::table_trials(
        "connection_pool_markdown",
        "contracts/fixtures/connection_pool/connection_pool.json",
        "contracts/fixtures/statement_events/dbspec-set.json",
        "markdown",
    ));
}
