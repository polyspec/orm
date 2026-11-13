// Recipe conversion of the parameter chunking: FCV-3 and FCV-4 (docs/spec/feature-coverage.md), suite unit parameter_chunking-mysql.
//! The parameter_chunking recipe, contracts/fixtures/parameter_chunking/parameter_chunking.json, on mysql
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::table_trials(
        "parameter_chunking_mysql",
        "contracts/fixtures/parameter_chunking/parameter_chunking.json",
        "contracts/fixtures/parameter_chunking/dbspec-set.json",
        "mysql",
    )
}
