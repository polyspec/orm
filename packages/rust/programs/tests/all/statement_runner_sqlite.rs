//! Requirements: INT-150, INT-77, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
//! The statement_runner recipe, contracts/fixtures/statement_runner/statement_runner.json, on sqlite
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::table_trials(
        "statement_runner_sqlite",
        "contracts/fixtures/statement_runner/statement_runner.json",
        "contracts/fixtures/statement_events/dbspec-set.json",
        "sqlite",
    )
}
