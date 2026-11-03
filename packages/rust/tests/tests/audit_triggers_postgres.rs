//! The audit_triggers recipe, contracts/fixtures/audit_triggers/audit_triggers.json, on postgres
//! (docs/spec/feature-coverage.md FCV-3 and FCV-4).
//! Requirements: CFG-8, DBS-67, DBS-85, DBS-87, DBS-88, DBS-89, DBS-93, DBS-94, DBS-96, DBS-117, DIA-161, DSL-118, DSL-119, DSL-126, INT-38, INT-44.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::table_trials(
        "audit_triggers_postgres",
        "contracts/fixtures/audit_triggers/audit_triggers.json",
        "contracts/fixtures/audit_triggers/dbspec-set.json",
        "postgres",
    ));
}
