//! The load of a document set, tests/dbspec/load-set.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: SCH-12, DBS-156.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("dbspec_load_set_none", "tests/dbspec/load-set.json", recipe::NONE));
}
