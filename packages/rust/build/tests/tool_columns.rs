#[path = "common/physical_fixture.rs"]
mod physical_fixture;

use polyspec_orm_build::tool_db::{self, QueryLimits, Val};

#[tokio::test]
// Requirements: INT-135.
async fn physical_query_columns_preserve_empty_results_and_duplicate_aliases() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(30), check()).await.expect("column test deadline");
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
