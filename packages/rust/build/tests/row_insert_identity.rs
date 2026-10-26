use polyspec_orm_build::{
    catalog::{CatalogConnection, MutationPhase, TableMetadata, TableRef},
    tool_db::{self, GridCell, P},
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[path = "row_insert_identity/expression.rs"]
mod expression;
#[path = "lock_probe/mod.rs"]
mod lock_probe;

#[tokio::test]
// Requirements: INT-123.
async fn sqlite_automatic_primary_key_returns_and_stores_the_inserted_row() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let path = std::env::temp_dir().join(format!("orm-catalog-auto-key-{}.sqlite", std::process::id()));
    let _fixture = polyspec_orm_testcase::SqliteFile::own(path.clone(), "SQLite fixture path must be unowned before this run");
    let dsn = format!("sqlite://{}", path.display());
    let (database, mut seed, _) = tool_db::open(&dsn).await.expect("SQLite fixture connection");
    seed.exec("CREATE TABLE generated (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL)", &[]).await.expect("create automatic-key table");
    let mut catalog = CatalogConnection::connect(&dsn).await.expect("catalog connection");
    let table = TableRef { namespace: catalog.current_namespace().await.expect("namespace"), name: "generated".into() };
    let metadata = catalog.describe_table(&table).await.expect("automatic-key metadata");
    assert_eq!(metadata.columns.len(), 2);
    assert_eq!(metadata.columns[0].name, "id");
    assert_eq!(metadata.columns[0].native_type, "INTEGER");
    assert!(!metadata.columns[0].nullable);
    assert!(!metadata.columns[0].generated);
    assert!(metadata.columns[0].automatic_key);
    assert_eq!(metadata.columns[0].default_expression, None);
    assert!(!metadata.columns[0].expression_default);
    assert_eq!(metadata.columns[1].name, "payload");
    assert_eq!(metadata.columns[1].native_type, "TEXT");
    assert!(!metadata.columns[1].nullable);
    let result = insert_without_hooks(&catalog, &metadata, &[("payload".into(), P::S("generated".into()))]).await.expect("insert with database-owned key");
    assert_eq!(result.rows, vec![vec![GridCell::Integer(1), GridCell::Text("generated".into())]]);
    let stored = catalog.table_page(&table, 2, 0).await.expect("stored row");
    assert_eq!(stored.result.rows, result.rows);
    catalog.close().await;
    seed.exec("DROP TABLE generated", &[]).await.expect("remove owned table");
    drop(seed);
    database.close().await;
}

#[tokio::test]
// Requirements: INT-117.
async fn typed_catalog_writes_return_declared_temporal_fraction_digits() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let path = std::env::temp_dir().join(format!("orm-catalog-typed-temporal-{}.sqlite", std::process::id()));
    assert!(!path.exists(), "SQLite fixture path must be unowned before this run");
    let mut failures = Vec::new();
    for dialect in ["sqlite", "mysql", "postgres"] {
        polyspec_orm_testcase::step(format_args!("running {dialect}"));
        let dsn = match dialect {
            "sqlite" => format!("sqlite://{}", path.display()),
            "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").expect("MySQL owner fixture DSN"),
            _ => std::env::var("ORM_TOOLS_POSTGRES_DSN").expect("PostgreSQL owner fixture DSN"),
        };
        let (database, mut seed, _) = tool_db::open(&dsn).await.expect("fixture connection");
        let name = format!("orm_typed_temporal_{}", std::process::id());
        let columns = if dialect == "sqlite" {
            "id INTEGER NOT NULL PRIMARY KEY, \
             t0 TIME NOT NULL CHECK (length(\"t0\") = 8 AND \"t0\" IS time(\"t0\") AND \"t0\" < '24:00:00'), \
             dt0 DATETIME NOT NULL CHECK (length(\"dt0\") = 19 AND \"dt0\" IS datetime(\"dt0\") AND substr(\"dt0\", 12, 2) < '24'), \
             t3 TIME NOT NULL CHECK (length(\"t3\") = 12 AND substr(\"t3\", 1, 8) IS time(substr(\"t3\", 1, 8)) AND \"t3\" < '24:00:00' AND substr(\"t3\", 9, 1) = '.' AND substr(\"t3\", 10) GLOB '[0-9][0-9][0-9]'), \
             dt3 DATETIME NOT NULL CHECK (length(\"dt3\") = 23 AND substr(\"dt3\", 1, 19) IS datetime(substr(\"dt3\", 1, 19)) AND substr(\"dt3\", 12, 2) < '24' AND substr(\"dt3\", 20, 1) = '.' AND substr(\"dt3\", 21) GLOB '[0-9][0-9][0-9]')"
        } else if dialect == "mysql" {
            "id BIGINT NOT NULL PRIMARY KEY, t0 TIME NULL, dt0 DATETIME NULL, t3 TIME(3) NULL, dt3 DATETIME(3) NULL"
        } else {
            "id BIGINT NOT NULL PRIMARY KEY, t0 TIME WITHOUT TIME ZONE NULL, dt0 TIMESTAMP WITHOUT TIME ZONE NULL, t3 TIME(3) WITHOUT TIME ZONE NULL, dt3 TIMESTAMP(3) WITHOUT TIME ZONE NULL"
        };
        seed.exec(&format!("CREATE TABLE {name} ({columns}){}", if dialect == "mysql" { " ENGINE=InnoDB" } else { "" }), &[])
            .await
            .expect("create typed temporal table");
        let mut catalog = CatalogConnection::connect(&dsn).await.expect("catalog connection");
        let table = TableRef { namespace: catalog.current_namespace().await.expect("namespace"), name: name.clone() };
        let metadata = catalog.describe_table(&table).await.expect("typed temporal metadata");
        let (t0, dt0) = if dialect == "postgres" { ("12:34:56.123456", "2026-01-02 03:04:05.123456") } else { ("12:34:56", "2026-01-02 03:04:05") };
        let values = [
            ("id".into(), P::I(1)),
            ("t0".into(), P::Time(t0.into())),
            ("dt0".into(), P::DateTime(dt0.into())),
            ("t3".into(), P::Time("12:34:56.123".into())),
            ("dt3".into(), P::DateTime("2026-01-02 03:04:05.123".into())),
        ];
        let expected = vec![vec![
            GridCell::Integer(1),
            GridCell::Time(t0.into()),
            GridCell::DateTime(dt0.into()),
            GridCell::Time("12:34:56.123".into()),
            GridCell::DateTime("2026-01-02 03:04:05.123".into()),
        ]];
        match insert_without_hooks(&catalog, &metadata, &values).await {
            Ok(result) if result.rows == expected => {}
            Ok(result) => failures.push(format!("{dialect}: typed temporal write returned {:?}", result.rows)),
            Err(error) => failures.push(format!("{dialect}: typed temporal write failed: {}", error.split(':').next().unwrap_or("unknown"))),
        }
        let invalid = [
            ("id".into(), P::I(2)),
            ("t0".into(), P::Time(t0.into())),
            ("dt0".into(), P::DateTime(dt0.into())),
            ("t3".into(), P::Time("12:34:56.1234".into())),
            ("dt3".into(), P::DateTime("2026-01-02 03:04:05.1234".into())),
        ];
        if insert_without_hooks(&catalog, &metadata, &invalid).await.is_ok() {
            failures.push(format!("{dialect}: excess temporal fraction digits were accepted"));
        }
        let stored = catalog.table_page(&table, 3, 0).await.expect("typed temporal stored rows");
        if stored.result.rows != expected {
            failures.push(format!("{dialect}: rejected typed write did not roll back: {:?}", stored.result.rows));
        }
        catalog.close().await;
        seed.exec(&format!("DROP TABLE {name}"), &[]).await.expect("remove typed temporal table");
        drop(seed);
        database.close().await;
        polyspec_orm_testcase::step(format_args!("{dialect} finished"));
    }
    std::fs::remove_file(path).expect("remove owned SQLite fixture");
    assert!(failures.is_empty(), "typed catalog temporal write failures: {failures:?}");
}

#[tokio::test]
// Requirements: DBS-113, INT-34.
async fn generated_keys_return_the_inserted_row_on_each_database() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(30), check()).await.expect("generated identity deadline");
}

async fn check() {
    let path = std::env::temp_dir().join(format!("orm-insert-identity-{}.sqlite", std::process::id()));
    assert!(!path.exists(), "fixture path must be unowned before this run");
    let mut failures = Vec::new();
    for dialect in ["sqlite", "mysql", "postgres"] {
        polyspec_orm_testcase::step(format_args!("running {dialect}"));
        let dsn = match dialect {
            "sqlite" => format!("sqlite://{}", path.display()),
            "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").expect("MySQL owner fixture DSN"),
            _ => std::env::var("ORM_TOOLS_POSTGRES_DSN").expect("PostgreSQL owner fixture DSN"),
        };
        let (database, mut seed, _) = tool_db::open(&dsn).await.expect("fixture connection");
        let name = format!("orm_insert_identity_{}", std::process::id());
        let key = match dialect {
            "sqlite" => "INTEGER PRIMARY KEY AUTOINCREMENT",
            "mysql" => "BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY",
            _ => "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
        };
        seed.exec(
            &format!(
                "CREATE TABLE {name}(seq {key},n BIGINT NOT NULL DEFAULT 7 UNIQUE,g BIGINT GENERATED ALWAYS AS(n+1) STORED){}",
                if dialect == "mysql" { " ENGINE=InnoDB" } else { "" }
            ),
            &[],
        )
        .await
        .expect("create owned table");
        let mut catalog = CatalogConnection::connect(&dsn).await.expect("catalog connection");
        let table = TableRef { namespace: catalog.current_namespace().await.unwrap(), name: name.clone() };
        let descriptor = catalog.describe_table(&table).await.expect("generated-key metadata");
        let phases = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = phases.clone();
        let publish: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(move |phase| captured.lock().unwrap().push(phase));
        let result =
            catalog.insert_row(&descriptor, &[("n".into(), P::I(10))], Arc::new(AtomicBool::new(false)), publish, std::sync::Arc::new(|| Ok(()))).await;
        match result {
            Ok(result)
                if result.rows.len() == 1
                    && result.rows[0].len() == 3
                    && matches!(result.rows[0][0], GridCell::Integer(value) if value > 0)
                    && result.rows[0][1..] == [GridCell::Integer(10), GridCell::Integer(11)]
                    && phases.lock().unwrap().last() == Some(&MutationPhase::Committed) =>
            {
                let actual = catalog.table_page(&table, 2, 0).await.expect("committed owner row");
                if actual.result.rows != result.rows {
                    failures.push(format!("{dialect}: returned row differs from committed row"));
                }
            }
            Ok(_) => failures.push(format!("{dialect}: generated row or commit phase mismatch")),
            Err(error) => failures.push(format!("{dialect}: {}", error.split(':').next().unwrap_or("unknown"))),
        }
        if let Err(error) = lifecycle(&mut catalog, &table).await {
            failures.push(format!("{dialect}: {error}"));
        }
        if dialect != "sqlite" && !schema_lock(&catalog, &dsn, &descriptor, &name, dialect).await {
            failures.push(format!("{dialect}: generated insert must lock the table before publishing Locked"));
        }
        let default_name = format!("{name}_defaults");
        seed.exec(
            &format!(
                "CREATE TABLE {default_name}(tenant BIGINT NOT NULL,seq VARCHAR(30) NOT NULL DEFAULT 'generated',n BIGINT NOT NULL,PRIMARY KEY(tenant,seq)){}",
                if dialect == "mysql" { " ENGINE=InnoDB" } else { "" }
            ),
            &[],
        )
        .await
        .expect("owned default composite-key fixture");
        let default_table = TableRef { namespace: table.namespace.clone(), name: default_name.clone() };
        let metadata = catalog.describe_table(&default_table).await.unwrap();
        let result = insert_without_hooks(&catalog, &metadata, &[("tenant".into(), P::I(2)), ("n".into(), P::I(50))]).await;
        if !matches!(result, Ok(ref value) if value.rows == vec![vec![GridCell::Integer(2),GridCell::Text("generated".into()),GridCell::Integer(50)]]) {
            failures.push(format!("{dialect}: composite default key mismatch"));
        }
        seed.exec(&format!("DROP TABLE {default_name}"), &[]).await.expect("remove default composite-key fixture");
        failures.extend(expression::check(&mut catalog, &mut seed, &table, &name, dialect).await);
        catalog.close().await;
        seed.exec(&format!("DROP TABLE {name}"), &[]).await.expect("remove owned table, even after a behavioral Red");
        drop(seed);
        database.close().await;
        polyspec_orm_testcase::step(format_args!("{dialect} finished"));
    }
    std::fs::remove_file(path).expect("remove owned SQLite fixture");
    assert!(failures.is_empty(), "generated identity failures: {failures:?}");
}

async fn lifecycle(catalog: &mut CatalogConnection, table: &TableRef) -> Result<(), String> {
    let descriptor = catalog.describe_table(table).await?;
    if !descriptor.columns[0].automatic_key || descriptor.columns[1].default_expression.is_none() {
        return Err("missing identity/default metadata".into());
    }
    let publish: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(|_| {});
    let left = [("n".into(), P::I(20))];
    let right = [("n".into(), P::I(30))];
    let (left, right) = tokio::join!(
        catalog.insert_row(&descriptor, &left, Arc::new(AtomicBool::new(false)), publish.clone(), std::sync::Arc::new(|| Ok(()))),
        catalog.insert_row(&descriptor, &right, Arc::new(AtomicBool::new(false)), publish.clone(), std::sync::Arc::new(|| Ok(())))
    );
    let (left, right) = (left?, right?);
    if left.rows.len() != 1
        || right.rows.len() != 1
        || left.rows[0][0] == right.rows[0][0]
        || left.rows[0][1..] != [GridCell::Integer(20), GridCell::Integer(21)]
        || right.rows[0][1..] != [GridCell::Integer(30), GridCell::Integer(31)]
    {
        return Err("concurrent inserts returned unrelated rows".into());
    }
    let default = catalog.insert_row(&descriptor, &[], Arc::new(AtomicBool::new(false)), publish.clone(), std::sync::Arc::new(|| Ok(()))).await?;
    if default.rows.len() != 1 || default.rows[0][1..] != [GridCell::Integer(7), GridCell::Integer(8)] {
        return Err("default-only insert mismatch".into());
    }
    let before = catalog.table_page(table, 10, 0).await?;
    if catalog
        .insert_row(&descriptor, &[("n".into(), P::I(20))], Arc::new(AtomicBool::new(false)), publish.clone(), std::sync::Arc::new(|| Ok(())))
        .await
        .is_ok()
    {
        return Err("unique constraint was ignored".into());
    }
    if catalog
        .insert_row(&descriptor, &[("n".into(), P::S("40".into()))], Arc::new(AtomicBool::new(false)), publish.clone(), std::sync::Arc::new(|| Ok(())))
        .await
        .is_ok()
    {
        return Err("coercion was accepted".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = cancelled.clone();
    let phases = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = phases.clone();
    let cancel: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(move |phase| {
        captured.lock().unwrap().push(phase);
        if phase == MutationPhase::Applied {
            flag.store(true, Ordering::SeqCst);
        }
    });
    let error = catalog.insert_row(&descriptor, &[("n".into(), P::I(40))], cancelled, cancel, std::sync::Arc::new(|| Ok(()))).await.unwrap_err();
    if !error.starts_with("JOB_CANCELLED") || phases.lock().unwrap().last() != Some(&MutationPhase::RolledBack) {
        return Err("generated insert cancellation did not confirm rollback".into());
    }
    let after = catalog.table_page(table, 10, 0).await?;
    if before.result.rows != after.result.rows {
        return Err("rejected/cancelled insert changed committed rows".into());
    }
    Ok(())
}

async fn schema_lock(catalog: &CatalogConnection, dsn: &str, metadata: &polyspec_orm_build::catalog::TableMetadata, name: &str, dialect: &str) -> bool {
    // At its Locked phase the insert stops while another connection probes the table lock (lock_probe), and then
    // is cancelled, so it rolls back.
    let held = Arc::new(std::sync::Mutex::new(None));
    let cancel = Arc::new(AtomicBool::new(false));
    let (probe_held, probe_cancel, probe_dsn, probe_dialect, probe_table) = (held.clone(), cancel.clone(), dsn.to_owned(), dialect.to_owned(), name.to_owned());
    let observe: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(move |phase| {
        if phase == MutationPhase::Locked {
            *probe_held.lock().unwrap() = Some(lock_probe::table_lock_held(&probe_dsn, &probe_dialect, &probe_table));
            probe_cancel.store(true, Ordering::SeqCst);
        }
    });
    let values = [("n".into(), P::I(99))];
    let result = catalog.insert_row(metadata, &values, cancel, observe, std::sync::Arc::new(|| Ok(()))).await;
    assert!(matches!(result, Err(ref error) if error.starts_with("JOB_CANCELLED")), "the probed insert ends cancelled: {result:?}");
    let held = held.lock().unwrap().unwrap_or(false);
    held
}

async fn insert_without_hooks(catalog: &CatalogConnection, metadata: &TableMetadata, values: &[(String, P)]) -> Result<tool_db::GridQueryResult, String> {
    catalog.insert_row(metadata, values, Arc::new(AtomicBool::new(false)), Arc::new(|_| {}), Arc::new(|| Ok(()))).await
}
