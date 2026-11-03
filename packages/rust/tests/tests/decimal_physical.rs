//! Exact decimal generated model cases on isolated databases, and the
//! generated models of the bench and decimal document sets on one connection.

use polyspec_orm_testcase::OrPanic;

polyspec_orm::models!();

#[allow(
    dead_code,
    unused_imports,
    clippy::all,
    reason = "the generated models are included whole, a crate uses only some of them, and lints of hand-written code do not apply to generated code"
)]
mod decimal_model {
    include!(concat!(env!("OUT_DIR"), "/decimal/orm_model.rs"));
}

async fn decimal_physical(env: &str) {
    use decimal_model::DecimalCase;

    let dsn = std::env::var(env)
        .or_panic(|error| format!("{env} is required ({error}); run the test through its make target, which reads the environment of make orm-test-servers"));
    assert!(!dsn.is_empty(), "{env} is empty");
    let db = decimal_model::connect(&dsn, 2, polyspec_orm::Config::default()).await.unwrap();
    let result: polyspec_orm::Result<()> = db
        .transaction(async || {
            let row = DecimalCase::new().set_seq(1).set_amount("48.0450")?.set_large_value(Some("9007199254740993".to_owned()))?.create().await?;
            assert_eq!(row.get_amount()?, "48.0450");
            let loaded = DecimalCase::new().get_by_seq(1).await?.ok_or(polyspec_orm::Error::NoRows)?;
            assert_eq!(loaded.get_amount()?, "48.0450");
            assert_eq!(loaded.get_large_value()?, Some("9007199254740993"));
            Err(polyspec_orm::Error::Config("decimal fixture rollback".into()))
        })
        .await;
    assert!(
        matches!(result, Err(polyspec_orm::Error::Config(ref message)) if message == "decimal fixture rollback"),
        "transaction rollback result: {result:?}"
    );
    db.close().await;
}

// Requirements: DIA-25, COD-2, DBS-108, SCH-7.
#[tokio::test]
async fn decimal_mysql() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    decimal_physical("DECIMAL_MYSQL_DSN").await;
}

// Requirements: DIA-25, COD-2, DBS-108, SCH-7.
#[tokio::test]
async fn decimal_postgres() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    decimal_physical("DECIMAL_POSTGRES_DSN").await;
}

// Requirements: DIA-25, COD-2, DBS-108, SCH-7.
#[tokio::test]
async fn decimal_sqlite() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    decimal_physical("DECIMAL_SQLITE_DSN").await;
}

/// Creates a new database on the server and returns its DSN through
/// ORM_TEST_<DRIVER>_DSN (a pooler in client-pooler-check) and its name;
/// SQLite uses a new file. The database is created and dropped through
/// ORM_TEST_<DRIVER>_SERVER_DSN: administration is server work, and the raw
/// sqlx connection sends startup parameters that a pooler rejects.
async fn schema_set_database(driver: &str) -> (String, String) {
    // Parallel tests may create names in the same microsecond, so names are told apart by process id and counter.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let count = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let name = format!("orm_schema_set_{}_{nanos}_{count}", std::process::id());
    if driver == "sqlite" {
        return (format!("sqlite://{}/{name}.sqlite", std::env::temp_dir().display()), name);
    }
    let env = format!("ORM_TEST_{}_DSN", driver.to_uppercase());
    let base = match std::env::var(&env) {
        Ok(value) => value,
        Err(error) => panic!("{env} is required ({error}); database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers"),
    };
    schema_set_server(driver, &format!("CREATE DATABASE {name}")).await;
    let (head, query) = base.split_once('?').map_or((base.as_str(), ""), |(h, q)| (h, q));
    let (server, _) = head.rsplit_once('/').expect("DSN names a database");
    let dsn = if query.is_empty() { format!("{server}/{name}") } else { format!("{server}/{name}?{query}") };
    (dsn, name)
}

async fn schema_set_server(driver: &str, statement: &str) {
    let env = format!("ORM_TEST_{}_SERVER_DSN", driver.to_uppercase());
    let base = match std::env::var(&env) {
        Ok(value) => value,
        Err(error) => panic!("{env} is required ({error}); database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers"),
    };
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

/// Counts the statements a connection sends in `runs` with a statement event
/// subscriber.
fn counted(db: &polyspec_orm::Db, runs: &std::sync::Arc<std::sync::atomic::AtomicUsize>) -> polyspec_orm::Subscription {
    let runs = runs.clone();
    db.subscribe(move |_: &polyspec_orm::StatementEvent<'_>| {
        runs.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    })
    .expect("a SQL connection accepts a subscriber")
}

/// A model of a manifest text edited under its declared hash is rejected with
/// SCHEMA_HASH_MISMATCH before execution, also after a model with the same
/// hash planned the same request (DBS-120).
async fn schema_set_edited_manifest(driver: &str) {
    use decimal_model::DecimalCase;

    let (dsn, name) = schema_set_database(driver).await;
    let text = decimal_model::SCHEMA.text();
    let edited = text.replace("decimal(13,4)", "decimal(14,4)");
    assert_ne!(edited, text, "edited manifest differs");
    let schema: &'static polyspec_orm::Schema =
        Box::leak(Box::new(polyspec_orm::Schema::new(Box::leak(edited.into_boxed_str()), decimal_model::MANIFEST_HASH)));
    let runs = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let db = decimal_model::connect(&dsn, 2, polyspec_orm::Config::default()).await.unwrap();
    let _counted = counted(&db, &runs);
    db.utils().schema().install(&decimal_model::SCHEMA).await.or_panic(|e| format!("{driver}: install: {e}"));
    DecimalCase::new().connect(&db).set_seq(1).set_amount("48.0450").unwrap().create().await.unwrap();
    // Plan the same request with the same hash first.
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

async fn drop_schema_set_database(driver: &str, dsn: &str, name: &str) {
    if driver == "sqlite" {
        std::fs::remove_file(dsn.trim_start_matches("sqlite://")).unwrap();
    } else {
        let drop = if driver == "postgres" { format!("DROP DATABASE {name} WITH (FORCE)") } else { format!("DROP DATABASE {name}") };
        schema_set_server(driver, &drop).await;
    }
}

// Requirements: DBS-120, SCH-7, SCH-11.
#[tokio::test]
async fn schema_set_edited_manifest_mysql() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    schema_set_edited_manifest("mysql").await;
}

// Requirements: DBS-120, SCH-7, SCH-11.
#[tokio::test]
async fn schema_set_edited_manifest_postgres() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    schema_set_edited_manifest("postgres").await;
}

// Requirements: DBS-120, SCH-7, SCH-11.
#[tokio::test]
async fn schema_set_edited_manifest_sqlite() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    schema_set_edited_manifest("sqlite").await;
}
