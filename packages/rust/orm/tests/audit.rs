//! Audit record transactions (docs/dbspec.md, "Audit"): a transaction inserts one audit record, built from the connection setting's audit source and its own audit values,
//! before the callback, and the executor writes its primary key to the audit column of every audited row that the transaction inserts or updates.
//! The rendered trigger copies each version to a history table. Run on SQLite,
//! MySQL, and PostgreSQL, each database runs in its own case database (polyspec-orm-case-database),
//! and it fails if ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is missing.

#[path = "common/audit_rows.rs"]
mod audit_rows;

use polyspec_orm_case_database::CaseDatabase;

/// Runs the case in a new case database for each driver. The case connects and installs audit.dbs.
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
