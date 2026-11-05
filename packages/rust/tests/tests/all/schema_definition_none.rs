//! The schema definition recipe, tests/dbspec/schema-definition.json, without a database (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: DBS-1, DBS-99, DBS-103, DBS-123, DBS-134, DBS-135, DBS-141, DBS-142, ORES-14.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::trials("schema_definition_none", "tests/dbspec/schema-definition.json", recipe::NONE)
}
