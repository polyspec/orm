//! The Rust transaction forms (transaction_send and transaction_once) with an audit. These stay native (FCV-2): only Rust has
//! these forms, and the audit behaviour that every runtime has is the recipe contracts/fixtures/audit_triggers/audit_triggers.json.
//! Audit record transactions (docs/spec/dbspec.md, "Audit"): a transaction inserts one audit record, built from the connection setting's audit source and its own audit values,
//! before the callback, and the executor writes its primary key to the audit column of every audited row that the transaction inserts or updates.
//! The rendered trigger copies each version to a history table. Run on SQLite,
//! MySQL, and PostgreSQL, each database runs in its own case database (polyspec-orm-case-database),
//! and it fails if ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is missing.

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

#[tokio::main(flavor = "current_thread")]
// Requirements: INT-44a.
async fn audit_transaction_entry_points() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    on_each_database("audit_transaction_entry_points", crate::audit_rows::entry_points_case).await;
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("audit": audit_transaction_entry_points)
}
