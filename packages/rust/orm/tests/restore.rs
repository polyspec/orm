//! Restore of a soft-deleted row (docs/operations/usage.md, "Writes"): finds a deleted row by the set values of one primary key or unique key,
//! writes an update that sets the soft delete column to NULL, and returns the restored row. On SQLite, MySQL, and PostgreSQL,
//! each database runs in its own case database (polyspec-orm-case-database), and it fails if ORM_TEST_MYSQL_DSN or
//! ORM_TEST_POSTGRES_DSN is missing.

#[path = "common/restore_rows.rs"]
mod restore_rows;

use polyspec_orm_case_database::CaseDatabase;

#[tokio::test]
async fn restore_soft_deleted_row() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        restore_rows::restore_case(driver, database.dsn()).await;
        database.drop().await;
        polyspec_orm_testcase::step(format_args!("restore_soft_deleted_row {driver}"));
    }
}
