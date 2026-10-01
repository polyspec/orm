use orm_build::catalog::CatalogConnection;

#[tokio::test]
async fn catalog_connection_does_not_create_a_missing_sqlite_database() {
    let path = std::env::temp_dir().join(format!("orm-catalog-missing-{}.sqlite", std::process::id()));
    assert!(!path.exists(), "test target must not already exist");
    let result = CatalogConnection::connect(&format!("sqlite://{}", path.display())).await;
    let rejected = result.is_err();
    if let Ok(connection) = result {
        connection.close().await;
    }
    let created = path.exists();
    if created {
        std::fs::remove_file(&path).expect("remove only the newly created owning test file");
    }
    assert!(rejected && !created, "catalog access must not create a database");
}

#[tokio::test]
async fn catalog_connection_rejects_invalid_dsn_without_driver_argument() {
    let started = std::time::Instant::now();
    eprintln!("running catalog_connection_rejects_invalid_dsn_without_driver_argument");
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), CatalogConnection::connect("unsupported://host/database"))
        .await
        .expect("catalog validation deadline");
    assert!(result.is_err());
    eprintln!("passed catalog_connection_rejects_invalid_dsn_without_driver_argument {:?}", started.elapsed());
}
