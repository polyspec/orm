//! The set parse cases of the dbspec set recipe, tests/dbspec/set-parse.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: DBS-2, DBS-171.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("set_parse_none", "tests/dbspec/set-parse.json", recipe::NONE));
}
