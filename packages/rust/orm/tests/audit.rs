//! audit 기록 transaction (docs/dbspec.md, "Audit"): transaction은 연결 설정의 audit source와 자기 audit 값으로
//! audit 기록 하나를 callback 전에 삽입하고, executor는 그 primary key를 transaction이 insert하거나 update하는
//! 모든 감사 대상 row의 audit column에 쓰며, render된 trigger는 각 version을 이력 table에 복사한다. SQLite,
//! MySQL, PostgreSQL에서 database마다 자기만의 case database(polyspec-orm-case-database)로 실행하며
//! ORM_TEST_MYSQL_DSN이나 ORM_TEST_POSTGRES_DSN이 없으면 실패한다.

#[path = "common/audit_rows.rs"]
mod audit_rows;

use polyspec_orm_case_database::CaseDatabase;

/// driver마다 새 case database에서 case를 실행한다. case가 연결하고 audit.dbs를 설치한다.
async fn on_each_database(name: &str, case: impl AsyncFn(&str, &str)) {
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        case(driver, database.dsn()).await;
        database.drop().await;
        polyspec_orm_testcase::step(format_args!("{name} {driver}"));
    }
}

#[tokio::test]
async fn audit_record_transaction() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    on_each_database("audit_record_transaction", audit_rows::audit_case).await;
}

#[tokio::test]
async fn audit_transaction_entry_points() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    on_each_database("audit_transaction_entry_points", audit_rows::entry_points_case).await;
}
