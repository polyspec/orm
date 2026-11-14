use crate::physical_fixture;

use polyspec_orm_build::tool_db::{self, QueryLimits, Val};

#[tokio::main(flavor = "current_thread")]
// Requirements: INT-135.
async fn physical_query_columns_preserve_empty_results_and_duplicate_aliases() {
    let _case = polyspec_orm_testcase::case!();
    check().await;
}
async fn check() {
    let path = physical_fixture::sqlite_path("tool-columns");
    for dialect in ["sqlite", "mysql", "postgres"] {
        polyspec_orm_testcase::step(format_args!("running {dialect}"));
        let dsn = physical_fixture::dsn_for(dialect, &path);
        let (database, mut connection, _) = tool_db::open(&dsn).await.unwrap();
        for tail in ["", " WHERE 1=0"] {
            let result =
                connection.query_result_bounded(&format!("SELECT 1 AS repeated, 'text' AS repeated{tail}"), &[], QueryLimits::default()).await.unwrap();
            assert_eq!(result.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["repeated", "repeated"]);
            assert!(result.columns.iter().all(|c| !c.native_type.is_empty()));
            assert_eq!(result.rows, if tail.is_empty() { vec![vec![Val::Int(1), Val::Text("text".into())]] } else { vec![] });
        }
        let mut catalog = polyspec_orm_build::catalog::CatalogConnection::connect(&dsn).await.unwrap();
        let result = catalog.query("SELECT 7 AS public_column", &[], QueryLimits::default()).await.unwrap();
        assert_eq!(result.columns[0].name, "public_column");
        assert_eq!(result.rows, vec![vec![Val::Int(7)]]);
        catalog.close().await;
        physical_fixture::finish_physical_dialect(database, connection, dialect, "passed").await;
    }
    std::fs::remove_file(path).unwrap();
}

#[tokio::main(flavor = "current_thread")]
// Requirements: INT-125a.
async fn physical_catalog_query_runs_a_stale_statement_again_on_postgres_alone() {
    let _case = polyspec_orm_testcase::case!();
    stale_statement().await;
}
async fn stale_statement() {
    let limits = QueryLimits::default;
    let path = physical_fixture::sqlite_path("tool-stale-statement");

    // A statement from before a schema change runs once more, and the connection is outside a transaction after it.
    let (database, connection, _) = tool_db::open(&physical_fixture::dsn_for("postgres", &path)).await.unwrap();
    let mut catalog = polyspec_orm_build::catalog::CatalogConnection::connect(&physical_fixture::dsn_for("postgres", &path)).await.unwrap();
    catalog.query("DROP TABLE IF EXISTS catalog_stale_statement", &[], limits()).await.unwrap();
    catalog.query("CREATE TABLE catalog_stale_statement (value INTEGER)", &[], limits()).await.unwrap();
    catalog.query("INSERT INTO catalog_stale_statement (value) VALUES (7)", &[], limits()).await.unwrap();
    let read = "SELECT value FROM catalog_stale_statement ORDER BY value";
    assert_eq!(catalog.query(read, &[], limits()).await.unwrap().rows, vec![vec![Val::Int(7)]]);
    catalog.query("ALTER TABLE catalog_stale_statement ALTER COLUMN value TYPE BIGINT", &[], limits()).await.unwrap();
    assert_eq!(catalog.query(read, &[], limits()).await.unwrap().rows, vec![vec![Val::Int(7)]]);
    catalog.query("INSERT INTO catalog_stale_statement (value) VALUES (8)", &[], limits()).await.unwrap();
    catalog.query("ROLLBACK", &[], limits()).await.unwrap();
    let kept = catalog.query(read, &[], limits()).await.unwrap().rows;
    assert_eq!(kept, vec![vec![Val::Int(7)], vec![Val::Int(8)]], "the statement that ran again left its transaction open");

    // Inside a transaction of the caller the failure has aborted it, so the error of the statement reaches the caller.
    catalog.query("BEGIN", &[], limits()).await.unwrap();
    catalog.query("ALTER TABLE catalog_stale_statement ALTER COLUMN value TYPE TEXT", &[], limits()).await.unwrap();
    let error = catalog.query(read, &[], limits()).await.unwrap_err();
    assert!(error.message().contains("cached plan must not change result type"), "{error}");
    catalog.query("ROLLBACK", &[], limits()).await.unwrap();
    catalog.query("DROP TABLE catalog_stale_statement", &[], limits()).await.unwrap();
    catalog.close().await;
    physical_fixture::finish_physical_dialect(database, connection, "postgres", "passed").await;

    // MySQL reports the same codes for the values of a statement: that error reaches the caller, and no transaction opens.
    let (database, connection, _) = tool_db::open(&physical_fixture::dsn_for("mysql", &path)).await.unwrap();
    let mut catalog = polyspec_orm_build::catalog::CatalogConnection::connect(&physical_fixture::dsn_for("mysql", &path)).await.unwrap();
    catalog.query("DROP TABLE IF EXISTS catalog_stale_statement", &[], limits()).await.unwrap();
    catalog.query("CREATE TABLE catalog_stale_statement (value TINYINT)", &[], limits()).await.unwrap();
    let error = catalog.query("INSERT INTO catalog_stale_statement (value) VALUES (1000)", &[], limits()).await.unwrap_err();
    assert!(error.message().contains("Out of range"), "{error}");
    let open = catalog.query("SELECT COUNT(*) FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id = CONNECTION_ID()", &[], limits()).await.unwrap();
    assert_eq!(open.rows, vec![vec![Val::Int(0)]], "a value error of MySQL opened a transaction");
    catalog.query("DROP TABLE catalog_stale_statement", &[], limits()).await.unwrap();
    catalog.close().await;
    physical_fixture::finish_physical_dialect(database, connection, "mysql", "passed").await;
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("tool_columns": physical_query_columns_preserve_empty_results_and_duplicate_aliases, physical_catalog_query_runs_a_stale_statement_again_on_postgres_alone)
}
