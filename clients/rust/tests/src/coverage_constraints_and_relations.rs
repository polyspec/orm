//! constraints_and_relations: database constraint 위반은 그 종류의 error code가 되고
//! 아무것도 바꾸지 않는다.
use super::coverage_env::{code, connect, run};
use super::model::{Author, User};

#[tokio::test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_constraint_errors() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    run("constraint_errors", async {
        let db = connect().await;
        let user = User::new().connect(&db).get_by_seq(1).await.unwrap();
        let author = Author::new().connect(&db).add_all_columns().get_by_seq(1).await.unwrap();
        let (user_before, author_before) = (user.to_array().unwrap(), author.to_array().unwrap());
        assert_eq!(code(user.delete(false).await), polyspec_orm::codes::FOREIGN_KEY, "delete a user that authors reference");
        let mut negative = author.clone().set_like_count(-1);
        assert_eq!(code(negative.update(false).await), polyspec_orm::codes::CONSTRAINT, "like_count violates ck_author_counts");
        let other = Author::new().connect(&db).get_by_seq(2).await.unwrap();
        let uuid = other.get_uuid().unwrap().expect("author 2 has a uuid").to_owned();
        let mut duplicate = author.set_uuid(uuid);
        assert_eq!(code(duplicate.update(false).await), polyspec_orm::codes::DUPLICATE_KEY, "uuid of author 2");
        assert_eq!(User::new().connect(&db).get_by_seq(1).await.unwrap().to_array().unwrap(), user_before, "user 1 changed");
        assert_eq!(Author::new().connect(&db).add_all_columns().get_by_seq(1).await.unwrap().to_array().unwrap(), author_before, "author 1 changed");
        db.close().await;
    })
    .await;
}
