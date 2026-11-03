//! The collection recipe, tests/collection/collection.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4): each case
//! runs the chain of tests/markdown/cases.json that its ir.answer step names on a listener that answers with the case's answer.
//! Requirements: INT-68, INT-69, INT-70, INT-71, INT-90, PRT-69.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("collection_none", "tests/collection/collection.json", recipe::NONE));
}
