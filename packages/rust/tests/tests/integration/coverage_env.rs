//! The deadline and progress output of a database case of the generated models.
use std::future::Future;
use std::time::Duration;

/// The deadline of one database case. It is measured in wall-clock time because it limits what the database does.
const DEADLINE: Duration = Duration::from_secs(300);

/// Runs `body` within the deadline and prints its start, success, and elapsed time.
pub async fn run<F: Future<Output = ()>>(case: &str, body: F) {
    polyspec_orm_testcase::run_with_deadline(case, DEADLINE, body).await;
}
