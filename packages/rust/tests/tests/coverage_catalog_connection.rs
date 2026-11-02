//! The one native check of catalog_connection (FCV-2, docs/spec/feature-coverage.md "Catalog connection exclusions"): the
//! MySQL server refuses a TIME(7) (DIA-54). The recipe's sql.exec step has no expect that a server refusal can meet, so the
//! check stays here. It takes its MySQL database from ORM_TEST_MYSQL_DSN, as the recipe entries do.
//! Requirements: INT-101.
use polyspec_orm_testcase::OrPanic;
use sqlx::MySqlPool;
use std::time::Duration;

/// The deadline for the case. It is wall-clock time because it limits what the database does.
const DEADLINE: Duration = Duration::from_secs(300);

#[tokio::test]
// Requirements: INT-101.
async fn coverage_mysql_temporal_precision_limit() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    polyspec_orm_testcase::run_with_deadline("mysql_temporal_precision_limit", DEADLINE, async {
        let dsn = std::env::var("ORM_TEST_MYSQL_DSN").expect("ORM_TEST_MYSQL_DSN is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers");
        let suffix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock after UNIX epoch").as_nanos();
        let name = format!("catalog_temporal_precision_limit_{}_{}", std::process::id(), suffix);
        let pool = MySqlPool::connect(&dsn).await.or_panic(|error| format!("MySQL precision fixture connection: {error}"));
        let invalid = format!("CREATE TABLE {name} (id BIGINT PRIMARY KEY, t TIME(7))");
        let rejected: Result<(), String> = match sqlx::query(sqlx::AssertSqlSafe(invalid)).execute(&pool).await {
            Ok(_) => Err("MySQL accepted temporal precision 7".into()),
            Err(error) => {
                let message = error.to_string();
                if message.to_lowercase().contains("precision") {
                    Ok(())
                } else {
                    Err(format!("MySQL precision 7 failed for another reason: {message}"))
                }
            }
        };
        let cleanup = sqlx::query(sqlx::AssertSqlSafe(format!("DROP TABLE IF EXISTS {name}"))).execute(&pool).await;
        pool.close().await;
        cleanup.or_panic(|error| format!("MySQL precision rejection cleanup: {error}"));
        rejected.or_panic(|error| format!("MySQL precision limit: {error}"));
    })
    .await;
}
