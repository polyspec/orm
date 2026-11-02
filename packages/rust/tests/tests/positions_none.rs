//! The positions cases of the dbspec parse recipe, tests/dbspec/positions.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: ORES-72.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("positions_none", "tests/dbspec/positions.json", recipe::NONE));
}
