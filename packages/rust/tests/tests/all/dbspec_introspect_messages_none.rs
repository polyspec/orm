//! The SQLite unsupported column reason of tests/dbspec/introspect-messages.json on a memory connection (docs/spec/feature-coverage.md FCV-3, FCV-4).
//! Requirements: DIA-191.

use polyspec_orm_tests::recipe;

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    recipe::trials("dbspec_introspect_messages_none", "tests/dbspec/introspect-messages.json", recipe::NONE)
}
