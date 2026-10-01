use orm_build::{
    catalog::{CatalogConnection, MutationPhase, RowSnapshot, TableRef},
    tool_db::{self, P},
};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};

#[tokio::test]
async fn rejected_commit_permits_rollback_all_native_mutations() {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let path = std::env::temp_dir().join(format!("orm-commit-permit-{}.sqlite", std::process::id()));
        assert!(!path.exists());
        for dialect in ["sqlite", "mysql", "postgres"] {
            let started = std::time::Instant::now();
            eprintln!("running commit_permit:{dialect}");
            let dsn = match dialect {
                "sqlite" => format!("sqlite://{}", path.display()),
                "mysql" => std::env::var("ORM_TOOLS_MYSQL_DSN").unwrap(),
                _ => std::env::var("ORM_TOOLS_POSTGRES_DSN").unwrap(),
            };
            let (db, mut seed, _) = tool_db::open(&dsn).await.unwrap();
            let name = format!("orm_commit_permit_{}", std::process::id());
            seed.exec(
                &format!("CREATE TABLE {name}(id INTEGER NOT NULL PRIMARY KEY,n BIGINT NOT NULL){}", if dialect == "mysql" { " ENGINE=InnoDB" } else { "" }),
                &[],
            )
            .await
            .unwrap();
            seed.exec(&format!("INSERT INTO {name}(id,n) VALUES(1,10)"), &[]).await.unwrap();
            let mut catalog = CatalogConnection::connect(&dsn).await.unwrap();
            let table = TableRef { namespace: catalog.current_namespace().await.unwrap(), name: name.clone() };
            let page = catalog.table_page(&table, 1, 0).await.unwrap();
            let baseline = RowSnapshot::from_page(&page, 0).unwrap();
            let calls = Arc::new(AtomicUsize::new(0));
            let phases = Arc::new(Mutex::new(Vec::new()));
            let seen = phases.clone();
            let publish: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(move |phase| seen.lock().unwrap().push(phase));
            let counted = calls.clone();
            let reject: Arc<dyn Fn() -> Result<(), String> + Send + Sync> = Arc::new(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                Err("fixture durable intent rejected".into())
            });
            assert!(catalog
                .update_row(&baseline, &[("missing".into(), P::I(11))], Arc::new(AtomicBool::new(false)), publish.clone(), reject.clone())
                .await
                .is_err());
            assert_eq!(calls.load(Ordering::SeqCst), 0, "invalid changes cannot reach commit permission");
            for operation in 0..3 {
                phases.lock().unwrap().clear();
                let flag = Arc::new(AtomicBool::new(false));
                let result = match operation {
                    0 => catalog.update_row(&baseline, &[("n".into(), P::I(11))], flag, publish.clone(), reject.clone()).await.map(|_| ()),
                    1 => catalog.delete_row(&baseline, flag, publish.clone(), reject.clone()).await.map(|_| ()),
                    _ => catalog
                        .insert_row(&page.metadata, &[("id".into(), P::I(2)), ("n".into(), P::I(20))], flag, publish.clone(), reject.clone())
                        .await
                        .map(|_| ()),
                };
                assert!(result.unwrap_err().starts_with("ROW_COMMIT_PERMIT_FAILED"));
                let after = catalog.table_page(&table, 10, 0).await.unwrap();
                assert_eq!(after.result, page.result);
                let phases = phases.lock().unwrap();
                assert!(phases.contains(&MutationPhase::Applied));
                assert_eq!(phases.last(), Some(&MutationPhase::RolledBack));
                assert!(!phases.contains(&MutationPhase::CommitStarted));
                assert!(!phases.contains(&MutationPhase::Committed));
            }
            assert_eq!(calls.load(Ordering::SeqCst), 3);
            catalog.update_row(&baseline, &[("n".into(), P::I(11))], Arc::new(AtomicBool::new(false)), publish, Arc::new(|| Ok(()))).await.unwrap();
            let after = catalog.table_page(&table, 1, 0).await.unwrap();
            assert_eq!(after.result.rows[0][1], tool_db::GridCell::Integer(11));
            assert_eq!(phases.lock().unwrap().last(), Some(&MutationPhase::Committed));
            seed.exec(&format!("DROP TABLE {name}"), &[]).await.unwrap();
            catalog.close().await;
            drop(seed);
            db.close().await;
            eprintln!("passed commit_permit:{dialect} {:?}", started.elapsed());
        }
        std::fs::remove_file(path).unwrap();
    })
    .await
    .expect("commit permit deadline");
}
