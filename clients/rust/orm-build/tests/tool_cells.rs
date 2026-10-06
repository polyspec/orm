use polyspec_orm_build::tool_db;

#[tokio::test]
async fn physical_tool_cells_reject_loss_without_substituting_values() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(30), physical_tool_cells()).await.expect("physical tool cell test deadline");
}

async fn physical_tool_cells() {
    let path = std::env::temp_dir().join(format!("orm-tool-cells-{}.sqlite", std::process::id()));
    assert!(!path.exists());
    let mut failures = Vec::new();
    for dialect in ["sqlite", "mysql", "postgres"] {
        polyspec_orm_testcase::step(format_args!("running {dialect}"));
        let dsn = match dialect {
            "sqlite" => format!("sqlite://{}", path.display()),
            "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").expect("declared MySQL test DSN"),
            _ => std::env::var("ORM_TOOLS_POSTGRES_DSN").expect("declared PostgreSQL test DSN"),
        };
        let (database, mut connection, _) = tool_db::open(&dsn).await.expect("owning test connection");
        let float = match dialect {
            "postgres" => "SELECT 1.5::double precision",
            "mysql" => "SELECT CAST(1.5 AS DOUBLE)",
            _ => "SELECT 1.5",
        };
        if connection.query(float, &[]).await.is_ok() {
            failures.push(format!("{dialect}:unsupported-type"));
        }
        let bytes = if dialect == "postgres" { "SELECT decode('ff','hex')" } else { "SELECT X'FF'" };
        if connection.query(bytes, &[]).await.is_ok() {
            failures.push(format!("{dialect}:invalid-utf8"));
        }
        if dialect == "mysql" && connection.query("SELECT CAST(18446744073709551615 AS UNSIGNED)", &[]).await.is_ok() {
            failures.push("mysql:unsigned-overflow".into());
        }
        let valid = connection.query("SELECT 1, 'valid', NULL", &[]).await.expect("valid scalar query");
        assert_eq!(valid[0], vec![tool_db::Val::Int(1), tool_db::Val::Text("valid".into()), tool_db::Val::Null]);
        drop(connection);
        database.close().await;
        polyspec_orm_testcase::step(format_args!("{dialect} finished"));
    }
    std::fs::remove_file(path).expect("remove owned SQLite test fixture");
    assert!(failures.is_empty(), "lossy cases accepted: {failures:?}");
}
