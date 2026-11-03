//! model_queries: the duplicate relation name on a temporary SQLite file. The reads of the generated model are cases of
//! the recipes model_queries and model_queries_chain (FCV-8).
use super::model::{Author, User};

#[tokio::test]
// Requirements: CPX-5, DSL-128.
async fn duplicate_relation_name_reports_config_alias_hint() {
    let fixture = super::temp_sqlite::TempSqlite::create("orm-cpx5");
    let db = polyspec_orm::Db::connect(&fixture.dsn(), 1, polyspec_orm::Config::default()).await.unwrap();
    let error = Author::new()
        .connect(&db)
        .relation(User::new().match_user_seq_with_seq())
        .relation(User::new().match_user_seq_with_seq())
        .get_query()
        .await
        .unwrap_err();
    match error {
        polyspec_orm::Error::Engine { code, msg } => {
            assert_eq!(code, "CONFIG");
            assert!(msg.contains("user_model"), "{msg}");
            assert!(msg.contains("alias<Name>()"), "{msg}");
        }
        error => panic!("expected CONFIG, got {error}"),
    }
    db.close().await;
}
