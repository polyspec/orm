//! The drop of a case database on MySQL (docs/spec/dialects.md DIA-212, DIA-200): the next session of the admin
//! DSN has foreign_key_checks 1 (polyspec_orm_case_database::next_admin_checks).

#[tokio::main(flavor = "current_thread")]
async fn drop_leaves_the_next_admin_session_with_foreign_key_checks() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    assert_eq!(polyspec_orm_case_database::next_admin_checks("mysql").await, 1, "the next admin session has the foreign_key_checks of the drop");
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("case_database_mysql": drop_leaves_the_next_admin_session_with_foreign_key_checks)
}
