use orm_build::catalog::CatalogConnection;
use sqlx::Connection;

#[tokio::test]
async fn server_catalog_connections_read_repeatably_on_both_declared_databases() {
    for (dialect, variable) in [("mysql", "ORM_TOOLS_MYSQL_DSN"), ("postgres", "ORM_TOOLS_POSTGRES_DSN")] {
        let started = std::time::Instant::now();
        eprintln!("running server_catalog_connections_read_repeatably:{dialect}");
        let dsn = std::env::var(variable).unwrap_or_else(|_| panic!("required test environment {variable} is missing"));
        tokio::time::timeout(std::time::Duration::from_secs(30), async {
            let mut connection = CatalogConnection::connect(&dsn).await.expect("declared test connection");
            assert_eq!(connection.dialect(), dialect);
            let first = connection.tables(None).await.expect("first catalog read");
            let second = connection.tables(None).await.expect("second catalog read");
            let names = |tables: &[orm_build::live::Table]| {
                let mut names = tables.iter().map(|table| table.name.clone()).collect::<Vec<_>>(); names.sort(); names
            };
            assert_eq!(names(&first), names(&second));
            connection.close().await;
        }).await.expect("catalog connection/read deadline");
        eprintln!("passed server_catalog_connections_read_repeatably:{dialect} {:?}", started.elapsed());
    }
}

#[tokio::test]
async fn sqlite_catalog_reads_tables_and_foreign_keys_without_changing_rows() {
    let started = std::time::Instant::now();
    eprintln!("running sqlite_catalog_reads_tables_and_foreign_keys_without_changing_rows");
    let path = std::env::temp_dir().join(format!("orm-catalog-fixture-{}.sqlite", std::process::id()));
    assert!(!path.exists(), "owning test database must not already exist");
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&path).create_if_missing(true);
    let mut seed = sqlx::SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe("CREATE TABLE catalog_parent(seq INTEGER PRIMARY KEY AUTOINCREMENT); CREATE TABLE catalog_child(seq INTEGER PRIMARY KEY AUTOINCREMENT,parent_seq INTEGER NOT NULL REFERENCES catalog_parent(seq) ON DELETE CASCADE); INSERT INTO catalog_parent DEFAULT VALUES; INSERT INTO catalog_child(parent_seq) VALUES(1);".to_owned())).execute(&mut seed).await.unwrap();
    seed.close().await.unwrap();
    let bytes_before = std::fs::read(&path).unwrap();
    let mut catalog = CatalogConnection::connect(&format!("sqlite://{}",path.display())).await.unwrap();
    assert_eq!(catalog.dialect(), "sqlite");
    let tables = catalog.tables(None).await.unwrap();
    let child = tables.iter().find(|table|table.name=="catalog_child").unwrap();
    assert_eq!(child.foreign_keys.len(),1);
    assert_eq!(child.foreign_keys[0].columns,vec!["parent_seq"]);
    assert_eq!(child.foreign_keys[0].target,"catalog_parent");
    let selected = std::collections::HashSet::from(["catalog_parent".to_owned()]);
    assert_eq!(catalog.tables(Some(&selected)).await.unwrap().len(),1);
    assert!(catalog.manifest().await.is_ok());
    catalog.close().await;
    let bytes_after = std::fs::read(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    assert_eq!(bytes_before,bytes_after,"catalog access must preserve database contents");
    eprintln!("passed sqlite_catalog_reads_tables_and_foreign_keys_without_changing_rows {:?}",started.elapsed());
}

#[tokio::test]
async fn catalog_connection_does_not_create_a_missing_sqlite_database() {
    let path = std::env::temp_dir().join(format!("orm-catalog-missing-{}.sqlite", std::process::id()));
    assert!(!path.exists(), "test target must not already exist");
    let result = CatalogConnection::connect(&format!("sqlite://{}", path.display())).await;
    let rejected = result.is_err();
    if let Ok(connection) = result { connection.close().await; }
    let created = path.exists();
    if created { std::fs::remove_file(&path).expect("remove only the newly created owning test file"); }
    assert!(rejected && !created, "catalog access must not create a database");
}

#[tokio::test]
async fn catalog_connection_rejects_invalid_dsn_without_driver_argument() {
    let started = std::time::Instant::now();
    eprintln!("running catalog_connection_rejects_invalid_dsn_without_driver_argument");
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), CatalogConnection::connect("unsupported://host/database")).await.expect("catalog validation deadline");
    assert!(result.is_err());
    eprintln!("passed catalog_connection_rejects_invalid_dsn_without_driver_argument {:?}", started.elapsed());
}
