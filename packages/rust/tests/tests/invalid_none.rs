//! The invalid cases of the dbspec format recipe, tests/dbspec/invalid.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: ORES-19.
//! Requirements: DBS-136, DBS-137, DBS-138, DBS-139, DBS-144, ORES-4, ORES-5, ORES-6, ORES-7, ORES-8, ORES-9, ORES-10, ORES-11, ORES-13.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("invalid_none", "tests/dbspec/invalid.json", recipe::NONE));
}
