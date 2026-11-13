use super::pool_in_use;
use std::time::Duration;

#[test]
fn pool_in_use_counts_open_connections_not_idle() {
    let _case = polyspec_orm_testcase::start("pool in-use counts open connections, not idle", Duration::from_secs(1));
    assert_eq!(pool_in_use(1, 1), 0);
    assert_eq!(pool_in_use(1, 0), 1);
    assert_eq!(pool_in_use(4, 2), 2);
}

#[test]
#[should_panic(expected = "idle connections cannot exceed open connections")]
fn pool_in_use_rejects_an_impossible_pool_snapshot() {
    let _case = polyspec_orm_testcase::start("pool in-use rejects an impossible snapshot", Duration::from_secs(1));
    pool_in_use(1, 2);
}
