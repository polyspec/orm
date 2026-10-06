//! soft delete한 행의 restore (docs/usage.md, "Writes"): primary key나 unique key 하나의 set 값으로 지운 행을
//! 찾아 soft delete column을 NULL로 쓰는 update를 하고 되돌린 행을 돌려준다. SQLite, MySQL, PostgreSQL에서
//! database마다 자기만의 case database(polyspec-orm-case-database)로 실행하며 ORM_TEST_MYSQL_DSN이나
//! ORM_TEST_POSTGRES_DSN이 없으면 실패한다.

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
