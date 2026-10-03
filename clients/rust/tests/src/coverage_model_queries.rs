//! model_queries: 생성된 model의 count, 정렬과 limit, 합계, 선언된 relation을 시드된
//! bench database에서 읽는다.
use super::coverage_env::{connect, run};
use super::model::{Author, User};

#[tokio::test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_model_query_rows() {
    run("model_query_rows", async {
        let db = connect().await;
        assert_eq!(Author::new().connect(&db).user_seq(1).get_count().await.unwrap(), 20, "authors of user 1");
        let rows = Author::new().connect(&db).service_seq(7).order_by_seq_desc().limit(0, 3).gets().await.unwrap();
        let names: Vec<&str> = rows.models().map(|b| b.get_name().unwrap()).collect();
        assert_eq!(names, ["author-99906", "author-99806", "author-99706"], "service 7 by seq desc");
        assert_eq!(Author::new().connect(&db).service_seq(7).sum_read_count().get_sum().await.unwrap(), 456000.0, "read_count sum of service 7");
        let author = Author::new().connect(&db).relation(User::new().match_user_seq_with_seq()).get_by_seq(5000).await.unwrap();
        let user = author.get_user_model().unwrap().expect("the user relation of author 5000");
        assert_eq!(user.get_name().unwrap(), "user-1", "user of author 5000");
        db.close().await;
    })
    .await;
}
