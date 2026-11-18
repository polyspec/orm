//! A refused connect is not retried inside the reopen window (CFG-48): the server refuses at once, and no timer tries again.
// Requirements: CFG-48.
use super::refused_connect_is_retried;
use std::time::{Duration, Instant};

#[test]
fn a_refused_connect_inside_the_window_is_not_retried() {
    let _case = polyspec_orm_testcase::case!();
    let now = Instant::now();
    let reopen_until = now + Duration::from_secs(2);
    let message = "error returned from database: 1226 (42000): User 'o1' has exceeded the 'max_user_connections' resource";
    assert!(!refused_connect_is_retried(message, now, reopen_until));
}
