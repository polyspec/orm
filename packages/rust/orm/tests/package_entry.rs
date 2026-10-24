use polyspec_orm::{Db, Error, Schema, Val};

/// Requirements: INT-138.
#[test]
fn public_package_entry() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let _: Option<Db> = None;
    let _: Option<Schema> = None;
    let _: Option<Val> = None;
    assert_eq!(Error::NoRows.to_string(), "NO_ROWS: query returned no rows");
}
