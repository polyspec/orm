//! The canonical cases of the dbspec format recipe, tests/dbspec/canonical.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: ORES-19.
//! Requirements: DBS-133, ORES-1, ORES-3, ORES-13.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("canonical_none", "tests/dbspec/canonical.json", recipe::NONE));
}
