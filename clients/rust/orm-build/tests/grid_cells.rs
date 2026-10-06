use polyspec_orm_build::{
    catalog::CatalogConnection,
    tool_db::{GridCell, QueryLimits},
};

#[tokio::test]
async fn binary_grid_values_remain_distinct_from_text_and_null() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(30), check()).await.expect("grid cell deadline");
}

async fn check() {
    let path = std::env::temp_dir().join(format!("orm-grid-cells-{}.sqlite", std::process::id()));
    assert!(!path.exists());
    let mut failures = Vec::new();
    for dialect in ["sqlite", "mysql", "postgres"] {
        orm_testcase::step(format_args!("running {dialect}"));
        let dsn = match dialect {
            "sqlite" => format!("sqlite://{}", path.display()),
            "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").expect("MySQL fixture DSN"),
            _ => std::env::var("ORM_TOOLS_POSTGRES_DSN").expect("PostgreSQL fixture DSN"),
        };
        let (database, seed, _) = polyspec_orm_build::tool_db::open(&dsn).await.expect("fixture connection");
        drop(seed);
        let mut catalog = CatalogConnection::connect(&dsn).await.expect("catalog connection");
        let sql = if dialect == "postgres" {
            "SELECT decode('00ff','hex'), decode('6869','hex'), decode('','hex'), 'hi', NULL"
        } else {
            "SELECT X'00FF', X'6869', X'', 'hi', NULL"
        };
        let expected =
            vec![vec![GridCell::Binary(vec![0, 255]), GridCell::Binary(b"hi".to_vec()), GridCell::Binary(vec![]), GridCell::Text("hi".into()), GridCell::Null]];
        match catalog.read_only_grid_query(sql, &[], QueryLimits::default()).await {
            Ok(result) if result.rows == expected && result.columns.len() == 5 => {}
            _ => failures.push(dialect),
        }
        let tiny = QueryLimits { max_rows: 1, max_bytes: 2 };
        if !catalog.read_only_grid_query(sql, &[], tiny).await.err().is_some_and(|error| error.contains("TOOL_QUERY_LIMIT")) {
            failures.push("binary-byte-budget");
        }
        let two_rows =
            if dialect == "postgres" { "SELECT decode('ff','hex') UNION ALL SELECT decode('ff','hex')" } else { "SELECT X'FF' UNION ALL SELECT X'FF'" };
        if !catalog
            .read_only_grid_query(two_rows, &[], QueryLimits { max_rows: 1, max_bytes: 1024 })
            .await
            .err()
            .is_some_and(|error| error.contains("TOOL_QUERY_LIMIT"))
        {
            failures.push("binary-row-budget");
        }
        if !catalog
            .read_only_grid_query("DELETE FROM grid_test_should_not_exist", &[], QueryLimits::default())
            .await
            .err()
            .is_some_and(|error| error.contains("QUERY_READ_ONLY"))
        {
            failures.push("mutation-policy");
        }
        let empty_sql = format!("{sql} WHERE 1=0");
        match catalog.read_only_grid_query(&empty_sql, &[], QueryLimits::default()).await {
            Ok(result) if result.rows.is_empty() && result.columns.len() == 5 => {}
            _ => failures.push("empty-metadata"),
        }
        let bind_sql = if dialect == "postgres" { "SELECT CAST($1 AS TEXT)" } else { "SELECT ?" };
        match catalog.read_only_grid_query(bind_sql, &[polyspec_orm_build::tool_db::s("text")], QueryLimits::default()).await {
            Ok(result) if result.rows == vec![vec![GridCell::Text("text".into())]] => {}
            _ => failures.push("bound-text"),
        }
        catalog.close().await;
        database.close().await;
        orm_testcase::step(format_args!("{dialect} finished"));
    }
    std::fs::remove_file(path).expect("remove owned SQLite fixture");
    assert!(failures.is_empty(), "grid type cases failed: {failures:?}");
}
