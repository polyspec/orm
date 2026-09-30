use orm_build::tool_db::{Conn, QueryLimits};

#[tokio::test]
async fn bounded_query_rejects_ambiguous_multiple_result_sets() {
    let started = std::time::Instant::now();
    eprintln!("running bounded_query_rejects_multiple_statements");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let mut connection = Conn::Sqlite(pool.acquire().await.unwrap());
        let error = connection.query_bounded("SELECT 1; SELECT 2", &[], QueryLimits::default()).await.expect_err("must not merge multiple result sets");
        assert!(error.to_string().contains("TOOL_QUERY_STATEMENT"));
        assert!(connection.query_bounded("SELECT ';'", &[], QueryLimits::default()).await.is_ok());
        drop(connection);
        pool.close().await;
    })
    .await
    .expect("statement test deadline");
    eprintln!("passed bounded_query_rejects_multiple_statements {:?}", started.elapsed());
}
