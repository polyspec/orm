//! Exact decimal generated model cases on isolated databases, and the
//! generated models of the bench and decimal document sets on one connection.

polyspec_orm::models!();

#[cfg(test)]
#[allow(dead_code, unused_imports, clippy::all)]
mod decimal_model {
    include!(concat!(env!("OUT_DIR"), "/decimal/orm_model.rs"));
}

#[cfg(test)]
async fn decimal_physical(env: &str) {
    use decimal_model::DecimalCase;

    let dsn = std::env::var(env)
        .unwrap_or_else(|_| panic!("{env} is required; run the test through its make target, which reads the environment of make test-servers"));
    assert!(!dsn.is_empty(), "{env} is empty");
    let db = decimal_model::connect(&dsn, 2, polyspec_orm::Config::default()).await.unwrap();
    let result: polyspec_orm::Result<()> = db
        .transaction(async || {
            let row = DecimalCase::new().set_seq(1).set_amount("48.0450")?.set_large_value(Some("9007199254740993".to_owned()))?.create().await?;
            assert_eq!(row.get_amount()?, "48.0450");
            let loaded = DecimalCase::new().get_by_seq(1).await?;
            assert_eq!(loaded.get_amount()?, "48.0450");
            assert_eq!(loaded.get_large_value()?, Some("9007199254740993"));
            Err(polyspec_orm::Error::Config("decimal fixture rollback".into()))
        })
        .await;
    assert!(
        matches!(result, Err(polyspec_orm::Error::Config(ref message)) if message == "decimal fixture rollback"),
        "transaction rollback result: {result:?}"
    );
    assert_eq!(DecimalCase::new().connect(&db).get_count().await.unwrap(), 0);
    db.close().await;
}

#[cfg(test)]
#[tokio::test]
#[ignore = "run by decimal-physical-check with the DECIMAL_*_DSN variables"]
async fn decimal_mysql() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    decimal_physical("DECIMAL_MYSQL_DSN").await;
}

#[cfg(test)]
#[tokio::test]
#[ignore = "run by decimal-physical-check with the DECIMAL_*_DSN variables"]
async fn decimal_postgres() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    decimal_physical("DECIMAL_POSTGRES_DSN").await;
}

#[cfg(test)]
#[tokio::test]
#[ignore = "run by decimal-physical-check with the DECIMAL_*_DSN variables"]
async fn decimal_sqlite() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    decimal_physical("DECIMAL_SQLITE_DSN").await;
}

/// Creates a new database on the server and returns its DSN through
/// ORM_TEST_<DRIVER>_DSN (a pooler in client-pooler-check) and its name;
/// SQLite uses a new file. The database is created and dropped through
/// ORM_TEST_<DRIVER>_SERVER_DSN: administration is server work, and the raw
/// sqlx connection sends startup parameters that a pooler rejects.
#[cfg(test)]
async fn schema_set_database(driver: &str) -> (String, String) {
    // 병렬 test가 같은 microsecond에 이름을 만들 수 있으므로 process id와 counter로 이름을 구분한다.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let count = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let name = format!("orm_schema_set_{}_{nanos}_{count}", std::process::id());
    if driver == "sqlite" {
        return (format!("sqlite://{}/{name}.sqlite", std::env::temp_dir().display()), name);
    }
    let env = format!("ORM_TEST_{}_DSN", driver.to_uppercase());
    let base = std::env::var(&env).unwrap_or_else(|_| {
        panic!("{env} is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers")
    });
    schema_set_server(driver, &format!("CREATE DATABASE {name}")).await;
    let (head, query) = base.split_once('?').map_or((base.as_str(), ""), |(h, q)| (h, q));
    let (server, _) = head.rsplit_once('/').expect("DSN names a database");
    let dsn = if query.is_empty() { format!("{server}/{name}") } else { format!("{server}/{name}?{query}") };
    (dsn, name)
}

#[cfg(test)]
async fn schema_set_server(driver: &str, statement: &str) {
    let env = format!("ORM_TEST_{}_SERVER_DSN", driver.to_uppercase());
    let base = std::env::var(&env).unwrap_or_else(|_| {
        panic!("{env} is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers")
    });
    let base = base.as_str();
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

/// The bench helper connects, installs the bench and decimal document sets
/// (the decimal set twice; the second installation changes nothing), and uses
/// the generated models of both sets on the connection inside and outside a
/// transaction.
#[cfg(test)]
async fn schema_set(driver: &str) {
    use decimal_model::DecimalCase;
    use model::User;

    let (dsn, name) = schema_set_database(driver).await;
    let db = model::connect(&dsn, 2, polyspec_orm::Config::default()).await.unwrap();
    for schema in [&model::SCHEMA, &decimal_model::SCHEMA, &decimal_model::SCHEMA] {
        db.utils().schema().install(schema).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
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
    drop_schema_set_database(driver, &dsn, &name).await;
}

#[cfg(test)]
#[tokio::test]
async fn schema_set_mysql() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    schema_set("mysql").await;
}

#[cfg(test)]
#[tokio::test]
async fn schema_set_postgres() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    schema_set("postgres").await;
}

#[cfg(test)]
#[tokio::test]
async fn schema_set_sqlite() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    schema_set("sqlite").await;
}

/// Counts the statements a connection sends in `runs` with a statement event
/// subscriber.
#[cfg(test)]
fn counted(db: &polyspec_orm::Db, runs: &std::sync::Arc<std::sync::atomic::AtomicUsize>) -> polyspec_orm::Subscription {
    let runs = runs.clone();
    db.subscribe(move |_: &polyspec_orm::StatementEvent<'_>| {
        runs.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    })
}

/// A request of a set that is not registered on its connection fails with
/// SCHEMA_HASH_MISMATCH before execution, also when its tables exist: a raw
/// connection registers no set, and a connection of the bench helper does not
/// register the decimal set that another connection installed. A connection
/// of the decimal helper uses it.
#[cfg(test)]
async fn schema_set_unregistered(driver: &str) {
    use decimal_model::DecimalCase;
    use model::User;

    let (dsn, name) = schema_set_database(driver).await;
    let runs = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let raw = polyspec_orm::Db::connect(&dsn, 2, polyspec_orm::Config::default()).await.unwrap();
    let _raw_counted = counted(&raw, &runs);
    let error = User::new().connect(&raw).get_count().await.expect_err("a bench read on a raw connection");
    assert_eq!(error.code(), "SCHEMA_HASH_MISMATCH", "{driver}: {error}");
    raw.close().await;
    let core = model::connect(&dsn, 2, polyspec_orm::Config::default()).await.unwrap();
    let _core_counted = counted(&core, &runs);
    let installer = decimal_model::connect(&dsn, 2, polyspec_orm::Config::default()).await.unwrap();
    installer.utils().schema().install(&decimal_model::SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    DecimalCase::new().connect(&installer).set_seq(1).set_amount("1.0000").unwrap().create().await.unwrap();
    installer.close().await;
    let error = DecimalCase::new().connect(&core).get_count().await.expect_err("a decimal read on the bench connection");
    assert_eq!(error.code(), "SCHEMA_HASH_MISMATCH", "{driver}: {error}");
    let error =
        DecimalCase::new().connect(&core).set_seq(2).set_amount("2.0000").unwrap().create().await.err().expect("a decimal write on the bench connection");
    assert_eq!(error.code(), "SCHEMA_HASH_MISMATCH", "{driver}: {error}");
    assert_eq!(runs.load(std::sync::atomic::Ordering::Relaxed), 0, "{driver}: statements of unregistered requests");
    core.close().await;
    let decimal = decimal_model::connect(&dsn, 2, polyspec_orm::Config::default()).await.unwrap();
    assert_eq!(DecimalCase::new().connect(&decimal).get_count().await.unwrap(), 1, "{driver}: decimal rows through the decimal helper");
    decimal.close().await;
    drop_schema_set_database(driver, &dsn, &name).await;
}

/// A schema whose manifest text does not hash to its declared manifestHash
/// fails with CONFIG before any statement when it is connected or installed,
/// and creates nothing. A model of that text is rejected with
/// SCHEMA_HASH_MISMATCH before execution, also after a model with the same
/// hash planned the same request.
#[cfg(test)]
async fn schema_set_edited_manifest(driver: &str) {
    use decimal_model::DecimalCase;

    let (dsn, name) = schema_set_database(driver).await;
    let text = decimal_model::SCHEMA.text();
    let edited = text.replace("decimal(13,4)", "decimal(14,4)");
    assert_ne!(edited, text, "edited manifest differs");
    let schema: &'static polyspec_orm::Schema =
        Box::leak(Box::new(polyspec_orm::Schema::new(Box::leak(edited.into_boxed_str()), decimal_model::MANIFEST_HASH)));
    let error = polyspec_orm::Db::connect_schema(&dsn, schema, 2, polyspec_orm::Config::default()).await.err().expect("a connection with an edited manifest");
    assert_eq!(error.code(), "CONFIG", "{driver}: {error}");
    let runs = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let db = decimal_model::connect(&dsn, 2, polyspec_orm::Config::default()).await.unwrap();
    let _counted = counted(&db, &runs);
    let error = db.utils().schema().install(schema).await.expect_err("an install of an edited manifest");
    assert_eq!(error.code(), "CONFIG", "{driver}: {error}");
    assert_eq!(runs.load(std::sync::atomic::Ordering::Relaxed), 0, "{driver}: statements of the edited install");
    db.utils().schema().install(&decimal_model::SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    DecimalCase::new().connect(&db).set_seq(1).set_amount("48.0450").unwrap().create().await.unwrap();
    // 같은 hash의 같은 요청을 먼저 plan해 둔다.
    assert_eq!(DecimalCase::new().connect(&db).get_count().await.unwrap(), 1, "{driver}: decimal rows");
    let entity: &'static polyspec_orm::Entity = Box::leak(Box::new(polyspec_orm::Entity {
        name: "decimal_case",
        schema,
        new: polyspec_orm::model::new_boxed::<DecimalCase>,
        collect: polyspec_orm::model::collect_boxed::<DecimalCase>,
    }));
    let before = runs.load(std::sync::atomic::Ordering::Relaxed);
    let mut core = polyspec_orm::Core::new(entity);
    core.connect(&db);
    let error = polyspec_orm::model::get_count(&core).await.expect_err("a request of an edited manifest");
    assert_eq!(error.code(), "SCHEMA_HASH_MISMATCH", "{driver}: {error}");
    assert_eq!(runs.load(std::sync::atomic::Ordering::Relaxed), before, "{driver}: statements of the edited request");
    assert_eq!(DecimalCase::new().connect(&db).get_count().await.unwrap(), 1, "{driver}: decimal rows after the rejected request");
    db.close().await;
    drop_schema_set_database(driver, &dsn, &name).await;
}

#[cfg(test)]
async fn drop_schema_set_database(driver: &str, dsn: &str, name: &str) {
    if driver == "sqlite" {
        std::fs::remove_file(dsn.trim_start_matches("sqlite://")).unwrap();
    } else {
        let drop = if driver == "postgres" { format!("DROP DATABASE {name} WITH (FORCE)") } else { format!("DROP DATABASE {name}") };
        schema_set_server(driver, &drop).await;
    }
}

#[cfg(test)]
#[tokio::test]
async fn schema_set_unregistered_mysql() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    schema_set_unregistered("mysql").await;
}

#[cfg(test)]
#[tokio::test]
async fn schema_set_unregistered_postgres() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    schema_set_unregistered("postgres").await;
}

#[cfg(test)]
#[tokio::test]
async fn schema_set_unregistered_sqlite() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    schema_set_unregistered("sqlite").await;
}

#[cfg(test)]
#[tokio::test]
async fn schema_set_edited_manifest_mysql() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    schema_set_edited_manifest("mysql").await;
}

#[cfg(test)]
#[tokio::test]
async fn schema_set_edited_manifest_postgres() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    schema_set_edited_manifest("postgres").await;
}

#[cfg(test)]
#[tokio::test]
async fn schema_set_edited_manifest_sqlite() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    schema_set_edited_manifest("sqlite").await;
}

fn main() {}
