use orm_build::{
    catalog::{CatalogConnection, MutationPhase, TableRef},
    tool_db::{self, GridCell, P},
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[path = "row_insert_identity/expression.rs"]
mod expression;

#[tokio::test]
async fn generated_keys_return_the_inserted_row_on_each_database() {
    let started = std::time::Instant::now();
    eprintln!("running generated_insert_identity");
    tokio::time::timeout(std::time::Duration::from_secs(30), check()).await.expect("generated identity deadline");
    eprintln!("passed generated_insert_identity {:?}", started.elapsed());
}

async fn check() {
    let path = std::env::temp_dir().join(format!("orm-insert-identity-{}.sqlite", std::process::id()));
    assert!(!path.exists(), "fixture path must be unowned before this run");
    let mut failures = Vec::new();
    for dialect in ["sqlite", "mysql", "postgres"] {
        let began = std::time::Instant::now();
        eprintln!("running generated_insert_identity:{dialect}");
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
        let result = catalog.insert_row(&descriptor, &[("n".into(), P::I(10))], Arc::new(AtomicBool::new(false)), publish).await;
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
        if dialect != "sqlite" && !schema_lock(&catalog, &mut seed, &descriptor, &name, dialect).await {
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
        let result =
            catalog.insert_row(&metadata, &[("tenant".into(), P::I(2)), ("n".into(), P::I(50))], Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await;
        if !matches!(result, Ok(ref value) if value.rows == vec![vec![GridCell::Integer(2),GridCell::Text("generated".into()),GridCell::Integer(50)]]) {
            failures.push(format!("{dialect}: composite default key mismatch"));
        }
        seed.exec(&format!("DROP TABLE {default_name}"), &[]).await.expect("remove default composite-key fixture");
        failures.extend(expression::check(&mut catalog, &mut seed, &table, &name, dialect).await);
        catalog.close().await;
        seed.exec(&format!("DROP TABLE {name}"), &[]).await.expect("remove owned table, even after a behavioral Red");
        drop(seed);
        database.close().await;
        eprintln!("finished generated_insert_identity:{dialect} {:?}", began.elapsed());
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
        catalog.insert_row(&descriptor, &left, Arc::new(AtomicBool::new(false)), publish.clone()),
        catalog.insert_row(&descriptor, &right, Arc::new(AtomicBool::new(false)), publish.clone())
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
    let default = catalog.insert_row(&descriptor, &[], Arc::new(AtomicBool::new(false)), publish.clone()).await?;
    if default.rows.len() != 1 || default.rows[0][1..] != [GridCell::Integer(7), GridCell::Integer(8)] {
        return Err("default-only insert mismatch".into());
    }
    let before = catalog.table_page(table, 10, 0).await?;
    if catalog.insert_row(&descriptor, &[("n".into(), P::I(20))], Arc::new(AtomicBool::new(false)), publish.clone()).await.is_ok() {
        return Err("unique constraint was ignored".into());
    }
    if catalog.insert_row(&descriptor, &[("n".into(), P::S("40".into()))], Arc::new(AtomicBool::new(false)), publish.clone()).await.is_ok() {
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
    let error = catalog.insert_row(&descriptor, &[("n".into(), P::I(40))], cancelled, cancel).await.unwrap_err();
    if !error.starts_with("JOB_CANCELLED") || phases.lock().unwrap().last() != Some(&MutationPhase::RolledBack) {
        return Err("generated insert cancellation did not confirm rollback".into());
    }
    let after = catalog.table_page(table, 10, 0).await?;
    if before.result.rows != after.result.rows {
        return Err("rejected/cancelled insert changed committed rows".into());
    }
    Ok(())
}

async fn schema_lock(catalog: &CatalogConnection, seed: &mut tool_db::Conn, metadata: &orm_build::catalog::TableMetadata, name: &str, dialect: &str) -> bool {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = std::sync::Mutex::new(Some(sender));
    let observe: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(move |phase| {
        if phase == MutationPhase::Locked {
            sender.lock().unwrap().take().unwrap().send(()).unwrap();
        }
    });
    let values = [("n".into(), P::I(99))];
    let mut pending = Box::pin(catalog.insert_row(metadata, &values, Arc::new(AtomicBool::new(false)), observe));
    tokio::select! {
        result = &mut pending => panic!("insert finished before lock probe: {}", result.is_ok()),
        ready = receiver => ready.unwrap(),
    }
    let rejected = if dialect == "mysql" {
        // An explicit server failure deadline, not polling or a retry timer.
        let original = seed.query("SELECT @@SESSION.lock_wait_timeout", &[]).await.unwrap();
        let original = original[0][0].int().unwrap();
        seed.exec("SET SESSION lock_wait_timeout=1", &[]).await.unwrap();
        let result = seed.exec(&format!("LOCK TABLES {name} WRITE"), &[]).await;
        if result.is_ok() {
            seed.exec("UNLOCK TABLES", &[]).await.unwrap();
        }
        seed.exec("SET SESSION lock_wait_timeout=?", &[P::I(original)]).await.unwrap();
        matches!(result,Err(ref error) if error.as_database_error()
            .and_then(|error| error.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()).is_some_and(|error| error.number()==1205))
    } else {
        seed.exec("BEGIN", &[]).await.unwrap();
        let rejected = seed.exec(&format!("LOCK TABLE {name} IN ACCESS EXCLUSIVE MODE NOWAIT"), &[]).await.is_err();
        seed.exec("ROLLBACK", &[]).await.unwrap();
        rejected
    };
    drop(pending);
    rejected
}
