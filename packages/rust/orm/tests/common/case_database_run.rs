//! Runs one database case under its deadline and drops its case database afterward.

use polyspec_orm_case_database::CaseDatabase;
use polyspec_orm_testcase::OrPanic;
use std::future::Future;
use std::time::Duration;

/// Awaits a case body under a deadline, then drops the database created for that case.
pub async fn run_case(database: CaseDatabase, driver: &str, case: &str, deadline: Duration, body: impl Future<Output = ()>) {
    tokio::time::timeout(deadline, body).await.or_panic(|_| format!("{driver}: {case}: timeout after {deadline:?}"));
    database.drop().await;
}
