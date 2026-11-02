//! The document set cases of the dbspec manifest recipe, tests/dbspec/sets.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: DBS-30, DBS-35, DBS-99, DBS-101, DBS-105, DBS-106, DBS-168.
//! Requirements: ORES-13.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("sets_none", "tests/dbspec/sets.json", recipe::NONE));
}
