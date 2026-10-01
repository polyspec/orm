//! Exact decimal generated model cases on isolated databases.

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
#[ignore = "run by decimal-physical-check with the DECIMAL_*_DSN variables"]
async fn decimal_mysql() {
    decimal_physical("DECIMAL_MYSQL_DSN").await;
}

#[cfg(test)]
#[tokio::test]
#[ignore = "run by decimal-physical-check with the DECIMAL_*_DSN variables"]
async fn decimal_postgres() {
    decimal_physical("DECIMAL_POSTGRES_DSN").await;
}

#[cfg(test)]
#[tokio::test]
#[ignore = "run by decimal-physical-check with the DECIMAL_*_DSN variables"]
async fn decimal_sqlite() {
    decimal_physical("DECIMAL_SQLITE_DSN").await;
}

fn main() {}
