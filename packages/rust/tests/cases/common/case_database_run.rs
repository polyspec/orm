//! Runs one database case and drops its case database afterward.

use polyspec_orm_case_database::CaseDatabase;
use std::future::Future;

/// Awaits a case body, then drops the database created for that case; no clock ends the body (T474).
pub async fn run_case(database: CaseDatabase, body: impl Future<Output = ()>) {
    body.await;
    database.drop().await;
}
