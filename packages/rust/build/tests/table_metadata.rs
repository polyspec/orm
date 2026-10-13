use polyspec_orm_build::{
    catalog::{CatalogConnection, TableRef},
    tool_db,
};

#[tokio::test]
async fn qualified_table_metadata_preserves_identity_and_generated_columns() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(30), check()).await.expect("table metadata deadline");
}
#[tokio::test]
async fn mysql_system_views_are_described_without_row_identity() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(10),async{
        let dsn=std::env::var("ORM_TOOLS_MYSQL_DSN").expect("MySQL fixture DSN");
        let mut catalog=CatalogConnection::connect(&dsn).await.expect("catalog connection");
        let native=catalog.query("SELECT TABLE_TYPE='SYSTEM VIEW' FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",&[tool_db::s("information_schema"),tool_db::s("TABLES")],tool_db::QueryLimits{max_rows:1,max_bytes:1024}).await.expect("native classification");
        assert!(native.rows.len()==1&&native.rows[0].len()==1&&native.rows[0][0].bool().unwrap(),"fixture must exercise native system-view classification");
        let result=catalog.describe_table(&TableRef{namespace:"information_schema".into(),name:"TABLES".into()}).await;
        catalog.close().await;
        assert!(matches!(result,Ok(ref metadata) if metadata.kind==polyspec_orm_build::catalog::TableKind::View&&!metadata.columns.is_empty()&&metadata.primary_key.is_empty()&&!metadata.reliable_row_identity),"system-view descriptor must remain read-only view metadata");
    }).await.expect("system view deadline");
}
async fn check() {
    let path = std::env::temp_dir().join(format!("orm-table-metadata-{}.sqlite", std::process::id()));
    assert!(!path.exists());
    let mut failures = Vec::new();
    for dialect in ["sqlite", "mysql", "postgres"] {
        polyspec_orm_testcase::step(format_args!("running {dialect}"));
        let dsn = match dialect {
            "sqlite" => format!("sqlite://{}", path.display()),
            "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").expect("MySQL fixture DSN"),
            _ => std::env::var("ORM_TOOLS_POSTGRES_DSN").expect("PostgreSQL fixture DSN"),
        };
        let (database, mut seed, _) = tool_db::open(&dsn).await.expect("fixture connection");
        let name = format!("orm_table_metadata_{}", std::process::id());
        seed.exec(
            &format!("CREATE TABLE {name}(a BIGINT NOT NULL,b BIGINT NOT NULL,note VARCHAR(50),g BIGINT GENERATED ALWAYS AS (a+1) STORED,PRIMARY KEY(b,a))"),
            &[],
        )
        .await
        .expect("owned fixture table");
        let mut catalog = CatalogConnection::connect(&dsn).await.expect("catalog connection");
        let namespace = catalog.current_namespace().await.expect("selected namespace");
        let reference = TableRef { namespace: namespace.clone(), name: name.clone() };
        match catalog.describe_table(&reference).await {
            Ok(metadata)
                if metadata.primary_key == vec!["b", "a"]
                    && metadata.columns.iter().map(|column| column.name.as_str()).collect::<Vec<_>>() == vec!["a", "b", "note", "g"]
                    && metadata.columns[2].nullable
                    && metadata.columns[3].generated
                    && metadata.reliable_row_identity => {}
            _ => failures.push(dialect),
        }
        if catalog.describe_table(&TableRef { namespace: namespace.clone(), name: "missing' OR '1'='1".into() }).await.is_ok() {
            failures.push("name-binding")
        }
        if catalog.describe_table(&TableRef { namespace: String::new(), name: name.clone() }).await.is_ok() {
            failures.push("empty-namespace")
        }
        for invalid in [String::new(), "bad\0name".into(), "x".repeat(1025)] {
            if catalog.describe_table(&TableRef { namespace: namespace.clone(), name: invalid }).await.is_ok() {
                failures.push("invalid-name")
            }
        }
        let view = format!("{name}_view");
        seed.exec(&format!("CREATE VIEW {view} AS SELECT a,b FROM {name}"), &[]).await.unwrap();
        match catalog.describe_table(&TableRef { namespace: namespace.clone(), name: view.clone() }).await {
            Ok(metadata)
                if metadata.kind == polyspec_orm_build::catalog::TableKind::View && !metadata.reliable_row_identity && metadata.primary_key.is_empty() => {}
            _ => failures.push("view-identity"),
        }
        if dialect == "sqlite" {
            seed.exec("CREATE TABLE nullable_key(a INTEGER,b INTEGER,PRIMARY KEY(b,a))", &[]).await.unwrap();
            seed.exec("CREATE TABLE rowid_key(a INTEGER PRIMARY KEY,note TEXT)", &[]).await.unwrap();
            match catalog.describe_table(&TableRef { namespace: namespace.clone(), name: "nullable_key".into() }).await {
                Ok(metadata) if !metadata.reliable_row_identity && metadata.columns.iter().all(|column| column.nullable) => {}
                _ => failures.push("nullable-key"),
            }
            match catalog.describe_table(&TableRef { namespace: namespace.clone(), name: "rowid_key".into() }).await {
                Ok(metadata) if metadata.reliable_row_identity && !metadata.columns[0].nullable => {}
                _ => failures.push("rowid-alias"),
            }
            seed.exec("CREATE TABLE desc_key(a INTEGER PRIMARY KEY DESC,note TEXT)", &[]).await.unwrap();
            seed.exec("CREATE TABLE without_rowid(a INTEGER,b INTEGER,PRIMARY KEY(b,a)) WITHOUT ROWID", &[]).await.unwrap();
            seed.exec("CREATE TABLE untyped(a INTEGER PRIMARY KEY,note)", &[]).await.unwrap();
            match catalog.describe_table(&TableRef { namespace: namespace.clone(), name: "desc_key".into() }).await {
                Ok(metadata) if !metadata.reliable_row_identity && metadata.columns[0].nullable => {}
                _ => failures.push("descending-key"),
            }
            match catalog.describe_table(&TableRef { namespace: namespace.clone(), name: "without_rowid".into() }).await {
                Ok(metadata)
                    if metadata.reliable_row_identity && metadata.primary_key == vec!["b", "a"] && metadata.columns.iter().all(|column| !column.nullable) => {}
                _ => failures.push("without-rowid"),
            }
            match catalog.describe_table(&TableRef { namespace: namespace.clone(), name: "untyped".into() }).await {
                Ok(metadata) if metadata.columns[1].native_type.is_empty() => {}
                _ => failures.push("untyped-column"),
            }
            if catalog.describe_table(&TableRef { namespace: "temp".into(), name: "rowid_key".into() }).await.is_ok() {
                failures.push("unsupported-namespace")
            }
        }
        catalog.close().await;
        seed.exec(&format!("DROP VIEW {view}"), &[]).await.expect("remove owned fixture view");
        seed.exec(&format!("DROP TABLE {name}"), &[]).await.expect("remove owned fixture table");
        drop(seed);
        database.close().await;
        polyspec_orm_testcase::step(format_args!("{dialect} finished"));
    }
    std::fs::remove_file(path).expect("remove owned SQLite fixture");
    assert!(failures.is_empty(), "table metadata cases failed: {failures:?}");
}
