use polyspec_orm::{Db, Error, Schema, Val};

/// Requirements: INT-138.
fn public_package_entry() {
    let _case = polyspec_orm_testcase::case!();
    let _: Option<Db> = None;
    let _: Option<Schema> = None;
    let _: Option<Val> = None;
    assert_eq!(Error::no_rows().to_string(), "no_rows: query returned no rows");
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("package_entry": public_package_entry)
}
