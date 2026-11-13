use polyspec_orm_build::{
    catalog::{CatalogConnection, CatalogError, MutationPhase, TableRef},
    tool_db::{self, GridCell, P},
};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[path = "row_insert_identity/expression.rs"]
mod expression;
use crate::lock_probe;

async fn open_dialect_fixture(dialect: &str, sqlite_path: &Path) -> (String, polyspec_orm::Db, tool_db::Conn) {
    let dsn = match dialect {
        "sqlite" => format!("sqlite://{}", sqlite_path.display()),
        "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").expect("MySQL owner fixture DSN"),
        "postgres" => std::env::var("ORM_TOOLS_POSTGRES_DSN").expect("PostgreSQL owner fixture DSN"),
        _ => panic!("unsupported row-insert fixture dialect {dialect}"),
    };
    let (database, seed, _) = tool_db::open(&dsn).await.expect("fixture connection");
    (dsn, database, seed)
}

async fn close_dialect_fixture(
    catalog: CatalogConnection,
    mut seed: tool_db::Conn,
    database: polyspec_orm::Db,
    table: &str,
    dialect: &str,
    drop_message: &str,
) {
    catalog.close().await;
    seed.exec(&format!("DROP TABLE {table}"), &[]).await.expect(drop_message);
    drop(seed);
    database.close().await;
    polyspec_orm_testcase::step(format_args!("{dialect} finished"));
}

#[tokio::main(flavor = "current_thread")]
// Runtime-unique (FCV-14): the phase publisher, the cancellation flag and inserts joined on one connection exist only in the
// Rust insert_row; what any runtime answers is the recipe cases generated_keys and generated_key_lifecycle.
// Requirements: INT-123a.
async fn insert_phases_and_joined_keys_follow_the_transaction() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(30), check()).await.expect("generated identity deadline");
}

async fn check() {
    let path = std::env::temp_dir().join(format!("orm-insert-identity-{}.sqlite", std::process::id()));
    let _fixture = polyspec_orm_testcase::SqliteFile::own(path.clone(), "fixture path must be unowned before this run");
    let mut failures = Vec::new();
    for dialect in ["sqlite", "mysql", "postgres"] {
        polyspec_orm_testcase::step(format_args!("running {dialect}"));
        let (dsn, database, mut seed) = open_dialect_fixture(dialect, &path).await;
        let name = format!("orm_insert_identity_{}", std::process::id());
        let key = match dialect {
            "sqlite" => "INTEGER PRIMARY KEY AUTOINCREMENT",
            "mysql" => "BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY",
            _ => "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
        };
        seed.exec(&format!("CREATE TABLE {name}(seq {key},n BIGINT NOT NULL DEFAULT 7 UNIQUE,g BIGINT GENERATED ALWAYS AS(n+1) STORED)"), &[])
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
            Err(error) => failures.push(format!("{dialect}: {}", error.message().split(':').next().unwrap_or("unknown"))),
        }
        if let Err(error) = lifecycle(&mut catalog, &table).await {
            failures.push(format!("{dialect}: {error}"));
        }
        if dialect != "sqlite" && !schema_lock(&catalog, &dsn, &descriptor, &name, dialect).await {
            failures.push(format!("{dialect}: generated insert must lock the table before publishing Locked"));
        }
        failures.extend(expression::check(&mut catalog, &mut seed, &table, &name, dialect).await);
        close_dialect_fixture(catalog, seed, database, &name, dialect, "remove owned table, even after a behavioral Red").await;
    }
    assert!(failures.is_empty(), "generated identity failures: {failures:?}");
}

async fn lifecycle(catalog: &mut CatalogConnection, table: &TableRef) -> Result<(), CatalogError> {
    let descriptor = catalog.describe_table(table).await?;
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
    let before = catalog.table_page(table, 10, 0).await?;
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
    if !error.message().starts_with("JOB_CANCELLED") || phases.lock().unwrap().last() != Some(&MutationPhase::RolledBack) {
        return Err("generated insert cancellation did not confirm rollback".into());
    }
    let after = catalog.table_page(table, 10, 0).await?;
    if before.result.rows != after.result.rows {
        return Err("cancelled insert changed committed rows".into());
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
    assert!(matches!(result, Err(ref error) if error.message().starts_with("JOB_CANCELLED")), "the probed insert ends cancelled: {result:?}");
    let held = held.lock().unwrap().unwrap_or(false);
    held
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("row_insert_identity": insert_phases_and_joined_keys_follow_the_transaction)
}
