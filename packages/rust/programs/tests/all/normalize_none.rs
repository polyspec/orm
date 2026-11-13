//! The normalize cases of the dbspec format recipe, tests/dbspec/normalize.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: ORES-15, ORES-17, ORES-19.
//! Requirements: ORES-13.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::trials("normalize_none", "tests/dbspec/normalize.json", recipe::NONE)
}
