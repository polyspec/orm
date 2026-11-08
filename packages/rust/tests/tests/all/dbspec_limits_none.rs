//! The limit and stress recipe, tests/dbspec/limits.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: DBS-123, DBS-144, DBS-151, DBS-170.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::trials("dbspec_limits_none", "tests/dbspec/limits.json", recipe::NONE)
}
