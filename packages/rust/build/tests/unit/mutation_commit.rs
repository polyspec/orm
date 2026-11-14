use super::*;

#[tokio::test]
// Runtime-unique (FCV-14): explicitly_rejected is the private classifier of the Rust driver errors, and a broken transport during
// COMMIT comes only from a fault no public call produces; the outcomes any runtime answers are the case row_commit_outcomes.
// Requirements: INT-118a.
async fn broken_commit_acknowledgement_is_not_explicit_rejection() {
    let _case = polyspec_orm_testcase::case!();
    async {
        assert!(!explicitly_rejected(&sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "owned transport fault"))));
        assert!(!explicitly_rejected(&sqlx::Error::Protocol("owned protocol fault".into())));
    }
    .await;
}
