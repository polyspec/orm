use super::*;

#[tokio::test]
async fn broken_commit_acknowledgement_is_not_explicit_rejection() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        assert!(!explicitly_rejected(&sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "owned transport fault"))));
        assert!(!explicitly_rejected(&sqlx::Error::Protocol("owned protocol fault".into())));
    })
    .await
    .expect("commit ack classification deadline");
}
