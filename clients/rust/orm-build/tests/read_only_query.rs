use orm_build::{
    catalog::CatalogConnection,
    tool_db::{self, QueryLimits, Val},
};

#[tokio::test]
async fn actual_catalog_queries_enforce_read_only_scopes_on_three_databases() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(30), check()).await.expect("read-only query deadline");
}
async fn check() {
    let cleanup_ids = std::env::var("ORM_READONLY_CLEANUP_IDS")
        .ok()
        .map(|value| value.split(',').map(|id| id.parse::<u32>().expect("explicit owned fixture PID")).collect::<Vec<_>>())
        .unwrap_or_default();
    let path = std::env::temp_dir().join(format!("orm-query-readonly-{}.sqlite", std::process::id()));
    assert!(!path.exists());
    for dialect in ["sqlite", "mysql", "postgres"] {
        orm_testcase::step(format_args!("running {dialect}"));
        let dsn = match dialect {
            "sqlite" => format!("sqlite://{}", path.display()),
            "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").unwrap(),
            _ => std::env::var("ORM_TOOLS_POSTGRES_DSN").unwrap(),
        };
        let (database, mut seed, _) = tool_db::open(&dsn).await.unwrap();
        for id in &cleanup_ids {
            assert!(
                std::fs::symlink_metadata(std::env::temp_dir().join(format!("orm-query-readonly-{id}.sqlite"))).unwrap().is_file(),
                "cleanup requires an identified owned SQLite fixture, not a symlink"
            );
            seed.exec(&format!("DROP TABLE IF EXISTS orm_readonly_query_{id}"), &[]).await.unwrap();
            if dialect == "mysql" {
                seed.exec(&format!("DROP FUNCTION IF EXISTS orm_readonly_function_{id}"), &[]).await.unwrap();
            }
            orm_testcase::step(format_args!("cleaned owned read-only fixture {dialect} {id}"));
        }
        let table = format!("orm_readonly_query_{}", std::process::id());
        seed.exec(&format!("CREATE TABLE {table}(n INTEGER NOT NULL)"), &[]).await.unwrap();
        seed.exec(&format!("INSERT INTO {table}(n) VALUES(7)"), &[]).await.unwrap();
        let mut catalog = CatalogConnection::connect(&dsn).await.unwrap();
        if dialect == "mysql" {
            let function = format!("orm_readonly_function_{}", std::process::id());
            seed.exec(
                &format!("CREATE FUNCTION {function}() RETURNS INTEGER DETERMINISTIC MODIFIES SQL DATA BEGIN UPDATE {table} SET n=n+1; RETURN 1; END"),
                &[],
            )
            .await
            .unwrap();
            let result = catalog.read_only_query(&format!("SELECT {function}()"), &[], QueryLimits::default()).await;
            seed.exec(&format!("DROP FUNCTION {function}"), &[]).await.unwrap();
            assert!(result.is_err(), "database must reject function writes");
        } else {
            let state_sql = if dialect == "postgres" { "SELECT current_setting('transaction_read_only')" } else { "SELECT query_only FROM pragma_query_only" };
            let state = catalog.read_only_query(state_sql, &[], QueryLimits::default()).await.unwrap();
            assert_eq!(state.rows[0][0], if dialect == "postgres" { Val::Text("on".into()) } else { Val::Int(1) });
        }
        for sql in [
            format!("UPDATE {table} SET n=8"),
            format!("DELETE FROM {table}"),
            "COMMIT".into(),
            "SELECT 1; SELECT 2".into(),
            "SELECT 1 INTO new_table".into(),
            "SELECT 1 /*! INTO OUTFILE '/private-value' */".into(),
        ] {
            let error = catalog.read_only_query(&sql, &[], QueryLimits::default()).await.unwrap_err();
            assert!(error.contains("QUERY_READ_ONLY"));
            assert!(!error.contains("private-value"));
        }
        assert!(catalog.read_only_query("SELECT 1 FROM missing_readonly_fixture", &[], QueryLimits::default()).await.is_err());
        let rows = catalog.read_only_query(&format!("SELECT n FROM {table}"), &[], QueryLimits::default()).await.unwrap();
        assert_eq!(rows.rows, vec![vec![Val::Int(7)]]);
        catalog.close().await;
        seed.exec(&format!("DROP TABLE {table}"), &[]).await.unwrap();
        drop(seed);
        database.close().await;
        orm_testcase::step(format_args!("{dialect} passed"));
    }
    std::fs::remove_file(path).unwrap();
    for id in cleanup_ids {
        std::fs::remove_file(std::env::temp_dir().join(format!("orm-query-readonly-{id}.sqlite"))).unwrap();
    }
}
