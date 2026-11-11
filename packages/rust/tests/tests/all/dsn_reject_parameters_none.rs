//! The refused DSN parameters, contracts/fixtures/dsn_reject/dsn_reject_parameters.json, without a database
//! (docs/spec/feature-coverage.md FCV-3).
//! Requirements: CFG-12, CFG-19, CFG-20, CFG-37, INT-187.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::trials("dsn_reject_parameters_none", "contracts/fixtures/dsn_reject/dsn_reject_parameters.json", recipe::NONE)
}
