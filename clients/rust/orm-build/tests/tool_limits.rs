use orm_build::tool_db::{self, QueryLimits, Val};

#[tokio::test]
async fn physical_tool_queries_reject_budgets_without_partial_success() {
    tokio::time::timeout(std::time::Duration::from_secs(30), check_databases()).await.expect("tool query budget test deadline");
}

async fn check_databases() {
    let path = std::env::temp_dir().join(format!("orm-tool-limits-{}.sqlite", std::process::id()));
    assert!(!path.exists());
    for dialect in ["sqlite", "mysql", "postgres"] {
        let started = std::time::Instant::now();
        eprintln!("running physical_tool_queries:{dialect}");
        let dsn = match dialect {
            "sqlite" => format!("sqlite://{}", path.display()),
            "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").expect("declared MySQL test DSN"),
            _ => std::env::var("ORM_TOOLS_POSTGRES_DSN").expect("declared PostgreSQL test DSN"),
        };
        let (database, mut connection, _) = tool_db::open(&dsn).await.expect("owner test connection");
        let bind_sql = if dialect == "postgres" { "SELECT $1::bigint" } else { "SELECT ?" };
        assert_eq!(connection.query_bounded(bind_sql, &[tool_db::P::I(7)], QueryLimits::default()).await.unwrap(), vec![vec![Val::Int(7)]]);
        assert!(connection.query_bounded("SELECT 1 WHERE 1=0", &[], QueryLimits { max_rows: 1, max_bytes: 2 }).await.unwrap().is_empty());
        let sql = "SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3";
        let rows = connection.query_bounded(sql, &[], QueryLimits { max_rows: 3, max_bytes: 1024 }).await.unwrap();
        assert_eq!(rows, vec![vec![Val::Int(1)], vec![Val::Int(2)], vec![Val::Int(3)]]);
        let encoded = serde_json::to_vec(&rows).unwrap().len();
        connection.query_bounded(sql, &[], QueryLimits { max_rows: 3, max_bytes: encoded }).await.unwrap();
        for limits in [
            QueryLimits { max_rows: 2, max_bytes: 1024 },
            QueryLimits { max_rows: 3, max_bytes: encoded - 1 },
            QueryLimits { max_rows: 0, max_bytes: 1024 },
            QueryLimits { max_rows: 3, max_bytes: 0 },
            QueryLimits { max_rows: 100_001, max_bytes: 1024 },
            QueryLimits { max_rows: 3, max_bytes: 64 * 1024 * 1024 + 1 },
        ] {
            let error = connection.query_bounded(sql, &[], limits).await.expect_err("budget must reject, not truncate");
            assert!(error.to_string().contains("TOOL_QUERY_LIMIT"));
            assert_eq!(connection.query("SELECT 1", &[]).await.unwrap(), vec![vec![Val::Int(1)]]);
        }
        let error = connection.query_bounded("SELECT 'private-cell-value'", &[], QueryLimits { max_rows: 1, max_bytes: 2 }).await.unwrap_err();
        assert!(!error.to_string().contains("private-cell-value"));
        drop(connection);
        database.close().await;
        eprintln!("passed physical_tool_queries:{dialect} {:?}", started.elapsed());
    }
    std::fs::remove_file(path).expect("remove owner SQLite fixture");
}
