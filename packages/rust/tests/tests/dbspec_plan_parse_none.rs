//! The plan parse errors of the recipe tests/dbspec/plan-parse.json without a database (docs/spec/feature-coverage.md FCV-3, FCV-4):
//! each case is the trial dbspec_plan_parse_none::<case id>, whose steps run through the shared runner.
//! Requirements: PLN-45, PLN-46, PLN-47, PLN-48, PLN-49, PLN-50, PLN-51, PLN-52, PLN-53, PLN-54, PLN-55, PLN-56, PLN-57,
//! PLN-58, PLN-59, PLN-60, PLN-61, PLN-62, PLN-63, PLN-64, PLN-65, PLN-66, PLN-67, PLN-68, PLN-69, PLN-70, PLN-71,
//! PLN-72, PLN-84, PLN-85, PLN-86, PLN-87, PLN-88, DBS-109.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("dbspec_plan_parse_none", "tests/dbspec/plan-parse.json", recipe::NONE));
}
