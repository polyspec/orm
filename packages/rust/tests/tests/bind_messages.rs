//! The markdown message and control recipe, tests/bind/messages.json, without a database (docs/spec/feature-coverage.md FCV-3,
//! FCV-4). Requirements: PRT-67.

use polyspec_orm_tests::recipe;

fn main() {
    polyspec_orm_testcase::run(recipe::trials("bind_messages", "tests/bind/messages.json", recipe::NONE));
}
