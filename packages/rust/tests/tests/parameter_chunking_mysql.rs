// Recipe conversion of the parameter chunking: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit parameter_chunking-mysql.
//! The parameter_chunking recipe, contracts/fixtures/parameter_chunking/parameter_chunking.json, on mysql
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::database_trials("parameter_chunking_mysql", "contracts/fixtures/parameter_chunking/parameter_chunking.json", "mysql"));
}
