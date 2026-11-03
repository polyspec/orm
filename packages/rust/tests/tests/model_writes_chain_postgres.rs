//! Requirements: COD-11, COD-12, COD-15, COD-38, DIA-26, DSL-104, DSL-107, INT-35, PRT-41, FCV-8, FCV-9, FCV-10, FCV-11, FCV-12, FCV-13, FCV-14 (docs/spec/feature-coverage.md).
//! The model_writes_chain recipe, contracts/fixtures/model_writes_chain/model_writes_chain.json, on postgres
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::table_trials(
        "model_writes_chain_postgres",
        "contracts/fixtures/model_writes_chain/model_writes_chain.json",
        "contracts/fixtures/model_chain/dbspec-set.json",
        "postgres",
    ));
}
