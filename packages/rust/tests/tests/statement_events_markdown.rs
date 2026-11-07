//! Requirements: DBS-108, DBS-119, DBS-120, INT-55, INT-77, INT-91, SCH-7, SCH-11, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
//! The statement_events recipe, contracts/fixtures/statement_events/statement_events.json, on markdown
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).
//! Requirements: DBS-108, DBS-119, DBS-120, INT-55, INT-77, INT-91, SCH-7, SCH-11, INT-96, PLN-44.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::table_trials(
        "statement_events_markdown",
        "contracts/fixtures/statement_events/statement_events.json",
        "contracts/fixtures/statement_events/dbspec-set.json",
        "markdown",
    ));
}
