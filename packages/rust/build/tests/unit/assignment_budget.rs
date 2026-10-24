use super::*;

#[tokio::test]
async fn rust_duplicate_assignment_budget_checks_additions_and_the_exact_limit() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        assert_eq!(add(0, 3, MAX_BYTES - 3), Some(MAX_BYTES));
        assert_eq!(add(0, 3, MAX_BYTES - 2), None);
        assert_eq!(add(usize::MAX, 1, 0), None);
        assert_eq!(add(0, 2, usize::MAX), None);
    })
    .await
    .expect("assignment budget deadline");
}
