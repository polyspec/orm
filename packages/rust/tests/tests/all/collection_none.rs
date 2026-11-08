//! The collection recipe, tests/collection/collection.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4): the
//! identity of a collection key of every type.
//! Requirements: INT-11, INT-63, PRT-35.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::trials("collection_none", "tests/collection/collection.json", recipe::NONE)
}
