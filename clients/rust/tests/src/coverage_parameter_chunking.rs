//! parameter_chunking: 모든 driver의 bind 한도를 넘는 root IN 목록은 나뉘어 실행되고 중복
//! 값은 한 번 읽힌다. 나누면 결과가 바뀌는 limit 모양은 IR_INVALID다.
use super::coverage_env::{code, connect, run};
use super::model::Author;

#[tokio::test]
#[ignore = "run by feature-check with ORM_FEATURE_DATABASE and ORM_FEATURE_DSN"]
async fn coverage_root_in_chunking() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    run("root_in_chunking", async {
        let db = connect().await;
        let values: Vec<i64> = (1..=70000).chain(1..=200).chain(200001..=200100).collect();
        assert_eq!(values.len(), 70300);
        assert_eq!(Author::new().connect(&db).seq(values.clone()).get_count().await.unwrap(), 70000, "count of the split IN list");
        assert_eq!(code(Author::new().connect(&db).seq(values).limit(0, 10).gets().await), polyspec_orm::codes::IR_INVALID, "limited split IN list");
        db.close().await;
    })
    .await;
}
