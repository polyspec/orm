//! Exact decimal generated model cases on isolated databases, and the
//! generated models of the core and decimal schemas on one connection.

orm::models!();

#[cfg(test)]
#[allow(dead_code, unused_imports, clippy::all)]
mod decimal_model {
    include!(concat!(env!("OUT_DIR"), "/decimal/orm_model.rs"));
}

#[cfg(test)]
async fn decimal_physical(env: &str) {
    use decimal_model::DecimalCase;

    let dsn = std::env::var(env).unwrap_or_else(|_| panic!("{env} is required"));
    assert!(!dsn.is_empty(), "{env} is empty");
    let db = orm::Db::connect(&dsn, 2, orm::Config::default()).await.unwrap();
    let result: orm::Result<()> = db
        .transaction(async || {
            let row = DecimalCase::new().set_seq(1).set_amount("48.0450")?.set_large_value(Some("9007199254740993".to_owned()))?.create().await?;
            assert_eq!(row.get_amount()?, "48.0450");
            let loaded = DecimalCase::new().get_by_seq(1).await?;
            assert_eq!(loaded.get_amount()?, "48.0450");
            assert_eq!(loaded.get_large_value()?, Some("9007199254740993"));
            Err(orm::Error::Config("decimal fixture rollback".into()))
        })
        .await;
    assert!(matches!(result, Err(orm::Error::Config(ref message)) if message == "decimal fixture rollback"), "transaction rollback result: {result:?}");
    assert_eq!(DecimalCase::new().connect(&db).get_count().await.unwrap(), 0);
    db.close().await;
}

#[cfg(test)]
#[tokio::test]
async fn decimal_mysql() {
    decimal_physical("DECIMAL_MYSQL_DSN").await;
}

#[cfg(test)]
#[tokio::test]
async fn decimal_postgres() {
    decimal_physical("DECIMAL_POSTGRES_DSN").await;
}

#[cfg(test)]
#[tokio::test]
async fn decimal_sqlite() {
    decimal_physical("DECIMAL_SQLITE_DSN").await;
}

/// Creates a new database on the server that ORM_TEST_<DRIVER>_DSN names and
/// returns its DSN and name; SQLite uses a new file.
#[cfg(test)]
async fn schema_set_database(driver: &str) -> (String, String) {
    let name = format!("orm_schema_set_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
    if driver == "sqlite" {
        return (format!("sqlite://{}/{name}.sqlite", std::env::temp_dir().display()), name);
    }
    let env = format!("ORM_TEST_{}_DSN", driver.to_uppercase());
    let base = std::env::var(&env).unwrap_or_else(|_| panic!("{env} is required; database tests never skip"));
    schema_set_server(driver, &base, &format!("CREATE DATABASE {name}")).await;
    let (head, query) = base.split_once('?').map_or((base.as_str(), ""), |(h, q)| (h, q));
    let (server, _) = head.rsplit_once('/').expect("DSN names a database");
    let dsn = if query.is_empty() { format!("{server}/{name}") } else { format!("{server}/{name}?{query}") };
    (dsn, name)
}

#[cfg(test)]
async fn schema_set_server(driver: &str, base: &str, statement: &str) {
    let sql = sqlx::SqlSafeStr::into_sql_str(sqlx::AssertSqlSafe(statement.to_owned()));
    if driver == "mysql" {
        let pool = sqlx::MySqlPool::connect(base).await.unwrap();
        sqlx::raw_sql(sql).execute(&pool).await.unwrap();
        pool.close().await;
    } else {
        let pool = sqlx::PgPool::connect(base).await.unwrap();
        sqlx::raw_sql(sql).execute(&pool).await.unwrap();
        pool.close().await;
    }
}

/// Opens one connection, installs the core and decimal manifests, and uses
/// the generated models of both schemas on it inside and outside a transaction.
#[cfg(test)]
async fn schema_set(driver: &str) {
    use decimal_model::DecimalCase;
    use model::User;

    let (dsn, name) = schema_set_database(driver).await;
    let core = std::fs::read("../../../schema/schema.json").unwrap();
    let decimal = std::fs::read("../../../contracts/fixtures/decimal_schema.json").unwrap();
    let db = orm::Db::connect(&dsn, 2, orm::Config::default()).await.unwrap();
    for manifest in [&core, &decimal, &decimal] {
        db.utils().schema().install(manifest).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    }
    User::new().connect(&db).set_name("core").create().await.unwrap();
    DecimalCase::new().connect(&db).set_seq(1).set_amount("48.0450").unwrap().create().await.unwrap();
    db.transaction(async || {
        User::new().set_name("core-tx").create().await?;
        DecimalCase::new().set_seq(2).set_amount("1.5000")?.create().await?;
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(User::new().connect(&db).get_count().await.unwrap(), 2, "{driver}: core rows");
    assert_eq!(DecimalCase::new().connect(&db).get_by_seq(1).await.unwrap().get_amount().unwrap(), "48.0450", "{driver}: decimal row");
    assert_eq!(DecimalCase::new().connect(&db).get_count().await.unwrap(), 2, "{driver}: decimal rows");
    db.close().await;
    if driver == "sqlite" {
        std::fs::remove_file(dsn.trim_start_matches("sqlite://")).unwrap();
    } else {
        let base = std::env::var(format!("ORM_TEST_{}_DSN", driver.to_uppercase())).unwrap();
        let drop = if driver == "postgres" { format!("DROP DATABASE {name} WITH (FORCE)") } else { format!("DROP DATABASE {name}") };
        schema_set_server(driver, &base, &drop).await;
    }
}

#[cfg(test)]
#[tokio::test]
async fn schema_set_mysql() {
    schema_set("mysql").await;
}

#[cfg(test)]
#[tokio::test]
async fn schema_set_postgres() {
    schema_set("postgres").await;
}

#[cfg(test)]
#[tokio::test]
async fn schema_set_sqlite() {
    schema_set("sqlite").await;
}

/// Registers the decimal manifest on a connection. Register creates nothing:
/// before installation the decimal table stays absent. After another
/// connection installs the manifest, the decimal models read and write on the
/// registering connection.
#[cfg(test)]
async fn register_schema(driver: &str) {
    use decimal_model::DecimalCase;

    let (dsn, name) = schema_set_database(driver).await;
    let core = std::fs::read("../../../schema/schema.json").unwrap();
    let decimal = std::fs::read("../../../contracts/fixtures/decimal_schema.json").unwrap();
    let fresh = orm::Db::connect(&dsn, 2, orm::Config::default()).await.unwrap();
    fresh.utils().schema().register(&decimal).await.unwrap_or_else(|e| panic!("{driver}: register: {e}"));
    let missing = DecimalCase::new().connect(&fresh).get_count().await.expect_err("register creates no table");
    assert_eq!(missing.code(), "DRIVER", "{driver}: read after register on an empty database: {missing}");
    fresh.close().await;
    let installer = orm::Db::connect(&dsn, 2, orm::Config::default()).await.unwrap();
    for manifest in [&core, &decimal] {
        installer.utils().schema().install(manifest).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    }
    installer.close().await;
    let db = orm::Db::connect(&dsn, 2, orm::Config::default()).await.unwrap();
    for _ in 0..2 {
        db.utils().schema().register(&decimal).await.unwrap_or_else(|e| panic!("{driver}: register: {e}"));
    }
    DecimalCase::new().connect(&db).set_seq(3).set_amount("2.5000").unwrap().create().await.unwrap();
    assert_eq!(DecimalCase::new().connect(&db).get_by_seq(3).await.unwrap().get_amount().unwrap(), "2.5000", "{driver}: decimal row");
    db.close().await;
    drop_schema_set_database(driver, &dsn, &name).await;
}

/// Registers a manifest whose content differs from its hash, which fails with
/// CONFIG.
#[cfg(test)]
async fn register_edited_manifest(driver: &str) {
    let (dsn, name) = schema_set_database(driver).await;
    let decimal = String::from_utf8(std::fs::read("../../../contracts/fixtures/decimal_schema.json").unwrap()).unwrap();
    let edited = decimal.replace("\"decimal_case\"", "\"decimal_edit\"");
    assert_ne!(edited, decimal, "edited manifest differs");
    let db = orm::Db::connect(&dsn, 2, orm::Config::default()).await.unwrap();
    let error = db.utils().schema().register(edited.as_bytes()).await.expect_err("register of an edited manifest");
    assert_eq!(error.code(), "CONFIG", "{driver}: {error}");
    db.close().await;
    drop_schema_set_database(driver, &dsn, &name).await;
}

#[cfg(test)]
async fn drop_schema_set_database(driver: &str, dsn: &str, name: &str) {
    if driver == "sqlite" {
        let _ = std::fs::remove_file(dsn.trim_start_matches("sqlite://"));
    } else {
        let base = std::env::var(format!("ORM_TEST_{}_DSN", driver.to_uppercase())).unwrap();
        let drop = if driver == "postgres" { format!("DROP DATABASE {name} WITH (FORCE)") } else { format!("DROP DATABASE {name}") };
        schema_set_server(driver, &base, &drop).await;
    }
}

#[cfg(test)]
#[tokio::test]
async fn register_schema_mysql() {
    register_schema("mysql").await;
}

#[cfg(test)]
#[tokio::test]
async fn register_schema_postgres() {
    register_schema("postgres").await;
}

#[cfg(test)]
#[tokio::test]
async fn register_schema_sqlite() {
    register_schema("sqlite").await;
}

#[cfg(test)]
#[tokio::test]
async fn register_edited_manifest_mysql() {
    register_edited_manifest("mysql").await;
}

#[cfg(test)]
#[tokio::test]
async fn register_edited_manifest_postgres() {
    register_edited_manifest("postgres").await;
}

#[cfg(test)]
#[tokio::test]
async fn register_edited_manifest_sqlite() {
    register_edited_manifest("sqlite").await;
}

fn main() {}
