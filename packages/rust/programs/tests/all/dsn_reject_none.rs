//! The refused DSN recipe, contracts/fixtures/dsn_reject/dsn_reject.json, without a database
//! (docs/spec/feature-coverage.md FCV-3).
//! Requirements: CFG-1, CFG-2, CFG-11, CFG-17, CFG-19, CFG-26, FCV-15, PRT-64.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::trials("dsn_reject_none", "contracts/fixtures/dsn_reject/dsn_reject.json", "none")
}
