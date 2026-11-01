//! The mermaid recipe, tests/dbspec/mermaid.json, without a database (docs/spec/feature-coverage.md FCV-3).
//! Requirements: MER-1, MER-2, MER-3, MER-4, MER-5, MER-6, MER-7, MER-8, MER-9, MER-10, MER-11, MER-12, MER-13.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("dbspec_mermaid_none", "tests/dbspec/mermaid.json", recipe::NONE));
}
