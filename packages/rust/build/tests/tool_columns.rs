use polyspec_orm_build::tool_db::{self, QueryLimits, Val};

#[tokio::test]
async fn physical_query_columns_preserve_empty_results_and_duplicate_aliases() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(30), check()).await.expect("column test deadline");
}
async fn check() {
    let path = std::env::temp_dir().join(format!("orm-tool-columns-{}.sqlite", std::process::id()));
    assert!(!path.exists());
    for dialect in ["sqlite", "mysql", "postgres"] {
        polyspec_orm_testcase::step(format_args!("running {dialect}"));
        let dsn = match dialect {
            "sqlite" => format!("sqlite://{}", path.display()),
            "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").unwrap(),
            _ => std::env::var("ORM_TOOLS_POSTGRES_DSN").unwrap(),
        };
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
        drop(connection);
        database.close().await;
        polyspec_orm_testcase::step(format_args!("{dialect} passed"));
    }
    std::fs::remove_file(path).unwrap();
}
