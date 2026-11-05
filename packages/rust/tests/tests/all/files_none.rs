//! The files cases of the dbspec file recipe, tests/dbspec/files.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: DBS-4, DBS-155, DBS-171.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::trials("files_none", "tests/dbspec/files.json", recipe::NONE)
}
