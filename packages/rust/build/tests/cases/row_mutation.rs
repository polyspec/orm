use crate::physical_fixture;

use polyspec_orm_build::{
    catalog::{CatalogConnection, MutationPhase, RowSnapshot, TableRef},
    tool_db::{self, GridCell, P},
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use crate::lock_probe;

#[tokio::main(flavor = "current_thread")]
// Runtime-unique (FCV-14): the phase publisher, the cancellation flag and a commit future that can be dropped exist only in
// the Rust update_row, delete_row and insert_row; what any runtime answers is the recipe case row_mutation_lifecycle.
// Requirements: INT-106a, INT-118, PRT-79.
async fn mutation_phases_follow_the_transaction() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(std::time::Duration::from_secs(30), check()).await.expect("native update deadline");
}
async fn check() {
    let path = physical_fixture::sqlite_path("row-mutation");
    let mut commit_rejection_misclassified = false;
    for dialect in ["sqlite", "mysql", "postgres"] {
        polyspec_orm_testcase::step(format_args!("running {dialect}"));
        let dsn = physical_fixture::dsn_for(dialect, &path);
        let (db, mut seed, _) = tool_db::open(&dsn).await.unwrap();
        let name = format!("orm_row_mutation_{}", std::process::id());
        seed.exec(
            &format!(
                "CREATE TABLE {name}(id INTEGER NOT NULL PRIMARY KEY,n BIGINT NOT NULL UNIQUE,g BIGINT GENERATED ALWAYS AS(n+1) STORED){}",
                if dialect == "mysql" { " ENGINE=InnoDB" } else { "" }
            ),
            &[],
        )
        .await
        .unwrap();
        seed.exec(&format!("INSERT INTO {name}(id,n) VALUES(1,10),(2,20)"), &[]).await.unwrap();
        let mut catalog = CatalogConnection::connect(&dsn).await.unwrap();
        let table = TableRef { namespace: catalog.current_namespace().await.unwrap(), name: name.clone() };
        let original = RowSnapshot::from_page(&catalog.table_page(&table, 1, 0).await.unwrap(), 0).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let publish: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(move |phase| captured.lock().unwrap().push(phase));
        let cancelled = Arc::new(AtomicBool::new(false));
        let result =
            catalog.update_row(&original, &[("n".into(), P::I(11))], cancelled.clone(), publish.clone(), std::sync::Arc::new(|| Ok(()))).await.unwrap();
        assert_eq!(result.rows[0], vec![GridCell::Integer(1), GridCell::Integer(11), GridCell::Integer(12)]);
        assert_eq!(events.lock().unwrap().last(), Some(&MutationPhase::Committed));
        let updated = RowSnapshot::from_page(&catalog.table_page(&table, 1, 0).await.unwrap(), 0).unwrap();
        assert_current_row(&mut catalog, &table, &updated).await;
        cancelled.store(true, Ordering::SeqCst);
        assert!(catalog
            .update_row(&updated, &[("n".into(), P::I(12))], cancelled.clone(), publish.clone(), std::sync::Arc::new(|| Ok(())))
            .await
            .unwrap_err()
            .starts_with("JOB_CANCELLED"));
        cancelled.store(false, Ordering::SeqCst);
        let stop = cancel_at_phase(&cancelled, MutationPhase::Locked);
        assert!(catalog
            .update_row(&updated, &[("n".into(), P::I(12))], cancelled, stop, std::sync::Arc::new(|| Ok(())))
            .await
            .unwrap_err()
            .starts_with("JOB_CANCELLED"));
        assert_current_row(&mut catalog, &table, &updated).await;
        let cancelled_after_write = Arc::new(AtomicBool::new(false));
        let stop = cancel_after_apply(&cancelled_after_write);
        assert!(catalog
            .update_row(&updated, &[("n".into(), P::I(12))], cancelled_after_write, stop, std::sync::Arc::new(|| Ok(())))
            .await
            .unwrap_err()
            .starts_with("JOB_CANCELLED"));
        assert_current_row(&mut catalog, &table, &updated).await;
        let late = Arc::new(AtomicBool::new(false));
        let flag = late.clone();
        let captured = events.clone();
        let at_commit: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(move |phase| {
            captured.lock().unwrap().push(phase);
            if phase == MutationPhase::CommitStarted {
                flag.store(true, Ordering::SeqCst)
            }
        });
        let result =
            catalog.update_row(&updated, &[("id".into(), P::I(0)), ("n".into(), P::I(12))], late, at_commit, std::sync::Arc::new(|| Ok(()))).await.unwrap();
        assert_eq!(result.rows[0], vec![GridCell::Integer(0), GridCell::Integer(12), GridCell::Integer(13)]);
        assert_eq!(events.lock().unwrap().last(), Some(&MutationPhase::Committed));
        let moved = RowSnapshot::from_page(&catalog.table_page(&table, 1, 0).await.unwrap(), 0).unwrap();
        // At its Locked phase the update stops while another connection probes the real database lock
        // (lock_probe), and then is cancelled, so it rolls back and the row stays as it was.
        let held = Arc::new(Mutex::new(None));
        let cancel = Arc::new(AtomicBool::new(false));
        let (probe_held, probe_cancel, probe_dsn, probe_dialect, probe_table) = (held.clone(), cancel.clone(), dsn.clone(), dialect.to_owned(), name.clone());
        let observe: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(move |phase| {
            if phase == MutationPhase::Locked {
                *probe_held.lock().unwrap() = Some(lock_probe::row_lock_held(&probe_dsn, &probe_dialect, &probe_table));
                probe_cancel.store(true, Ordering::SeqCst);
            }
        });
        let changes = vec![("n".into(), P::I(13))];
        let cancelled = catalog.update_row(&moved, &changes, cancel, observe, std::sync::Arc::new(|| Ok(()))).await.unwrap_err();
        assert!(cancelled.starts_with("JOB_CANCELLED"), "the probed update ends cancelled: {cancelled}");
        assert_eq!(*held.lock().unwrap(), Some(true), "owning update must hold the original row lock");
        // Acquiring the write lock again is event/driver-driven evidence that
        // the discarded connection released it, not a polling retry.
        seed.exec(&format!("UPDATE {name} SET n=n WHERE id=0"), &[]).await.unwrap();
        assert_current_row(&mut catalog, &table, &moved).await;
        if dialect == "postgres" {
            let function = format!("{name}_commit_check");
            let trigger = format!("{name}_commit_trigger");
            seed.exec(
                &format!("CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned commit rejection' USING ERRCODE='23514'; END; $$"),
                &[],
            )
            .await
            .unwrap();
            seed.exec(
                &format!("CREATE CONSTRAINT TRIGGER {trigger} AFTER UPDATE ON {name} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION {function}()"),
                &[],
            )
            .await
            .unwrap();
            let error = catalog
                .update_row(&moved, &[("n".into(), P::I(14))], Arc::new(AtomicBool::new(false)), publish.clone(), std::sync::Arc::new(|| Ok(())))
                .await
                .unwrap_err();
            if !error.starts_with("ROW_COMMIT_REJECTED") || events.lock().unwrap().last() != Some(&MutationPhase::RolledBack) {
                commit_rejection_misclassified = true;
            }
            assert_current_row(&mut catalog, &table, &moved).await;
            seed.exec(&format!("DROP TRIGGER {trigger} ON {name}"), &[]).await.unwrap();
            seed.exec(&format!("DROP FUNCTION {function}()"), &[]).await.unwrap();
        }
        let cancel_delete = Arc::new(AtomicBool::new(false));
        let stop = cancel_after_apply(&cancel_delete);
        assert!(catalog.delete_row(&moved, cancel_delete, stop, std::sync::Arc::new(|| Ok(()))).await.unwrap_err().starts_with("JOB_CANCELLED"));
        assert_current_row(&mut catalog, &table, &moved).await;
        let descriptor = catalog.table_page(&table, 2, 0).await.unwrap().metadata.clone();
        let flag = Arc::new(AtomicBool::new(false));
        let stop = cancel_after_apply(&flag);
        assert!(catalog
            .insert_row(&descriptor, &[("id".into(), P::I(4)), ("n".into(), P::I(40))], flag, stop, std::sync::Arc::new(|| Ok(())))
            .await
            .unwrap_err()
            .starts_with("JOB_CANCELLED"));
        let page = catalog.table_page(&table, 10, 0).await.unwrap();
        assert_eq!(page.result.rows.len(), 2);
        let inserted_baseline = RowSnapshot::from_page(&page, 1).unwrap();
        let (started, received) = tokio::sync::oneshot::channel();
        let (completed, completion) = tokio::sync::oneshot::channel();
        let started = Mutex::new(Some(started));
        let completed = Mutex::new(Some(completed));
        let observe: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(move |phase| {
            if phase == MutationPhase::CommitStarted {
                started.lock().unwrap().take().unwrap().send(()).unwrap();
            }
            if matches!(phase, MutationPhase::Committed | MutationPhase::Indeterminate) {
                completed.lock().unwrap().take().unwrap().send(phase).unwrap();
            }
        });
        let changes = vec![("n".into(), P::I(31))];
        let mut pending = Box::pin(catalog.update_row(&inserted_baseline, &changes, Arc::new(AtomicBool::new(false)), observe, std::sync::Arc::new(|| Ok(()))));
        // `biased` polls the probe first: when the probe event and the end of the commit are ready together, the probe is the
        // first event, so the order does not depend on which branch select! would pick at random.
        tokio::select! {
            biased;
            ready=received=>ready.unwrap(),
            result=&mut pending=>panic!("commit completed before detached-owner probe: {}",result.is_ok()),
        }
        drop(pending);
        assert_eq!(completion.await.unwrap(), MutationPhase::Committed);
        let page = catalog.table_page(&table, 10, 0).await.unwrap();
        assert_eq!(page.result.rows[1], vec![GridCell::Integer(2), GridCell::Integer(31), GridCell::Integer(32)]);
        if dialect == "postgres" {
            let baseline = RowSnapshot::from_page(&page, 1).unwrap();
            let function = format!("{name}_commit_block");
            let trigger = format!("{name}_commit_block_trigger");
            let lock = i64::from(std::process::id());
            seed.exec("SELECT pg_advisory_lock($1)", &[P::I(lock)]).await.unwrap();
            seed.exec(
                &format!(
                    "CREATE FUNCTION {function}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock({lock}); RETURN NEW; END; $$"
                ),
                &[],
            )
            .await
            .unwrap();
            seed.exec(
                &format!("CREATE CONSTRAINT TRIGGER {trigger} AFTER UPDATE ON {name} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION {function}()"),
                &[],
            )
            .await
            .unwrap();
            let (intent, received) = tokio::sync::oneshot::channel();
            let intent = Mutex::new(Some(intent));
            let captured = events.clone();
            let observe: Arc<dyn Fn(MutationPhase) + Send + Sync> = Arc::new(move |phase| {
                captured.lock().unwrap().push(phase);
                if phase == MutationPhase::CommitStarted {
                    intent.lock().unwrap().take().unwrap().send(()).unwrap();
                }
            });
            let changes = vec![("n".into(), P::I(32))];
            let mut pending = Box::pin(catalog.update_row(&baseline, &changes, Arc::new(AtomicBool::new(false)), observe, std::sync::Arc::new(|| Ok(()))));
            tokio::select! {
                result=&mut pending=>panic!("commit completed before owned transport fault: {}",result.is_ok()),
                ready=received=>ready.unwrap(),
            }
            let relation = format!("\"{}\".\"{}\"", table.namespace.replace('"', "\"\""), name);
            let owners = seed
                .grid_query_bounded(
                    "SELECT pid FROM pg_locks WHERE relation=to_regclass($1) AND mode='RowExclusiveLock' AND granted AND pid<>pg_backend_pid()",
                    &[P::S(relation)],
                    tool_db::QueryLimits { max_rows: 2, max_bytes: 65536 },
                )
                .await
                .unwrap();
            let pid = match owners.rows.as_slice() {
                [row] => match row.as_slice() {
                    [GridCell::Integer(pid)] => *pid,
                    _ => panic!("unexpected owned lock identity"),
                },
                _ => panic!("expected exactly one owned mutation connection"),
            };
            let killed = seed
                .grid_query_bounded("SELECT pg_terminate_backend($1::bigint::integer)", &[P::I(pid)], tool_db::QueryLimits { max_rows: 1, max_bytes: 65536 })
                .await
                .unwrap();
            assert_eq!(killed.rows, vec![vec![GridCell::Boolean(true)]]);
            let error = pending.await.unwrap_err();
            let cause = error
                .strip_prefix("ROW_COMMIT_INDETERMINATE: commit outcome unknown; do not retry: ")
                .expect("a terminated PostgreSQL backend leaves commit outcome indeterminate");
            assert!(
                cause.starts_with("error returned from database:") && cause.contains("terminating connection due to administrator command"),
                "the public error preserves the PostgreSQL driver cause: {cause}"
            );
            assert_eq!(events.lock().unwrap().last(), Some(&MutationPhase::Indeterminate));
            seed.exec("SELECT pg_advisory_unlock($1)", &[P::I(lock)]).await.unwrap();
            seed.exec(&format!("DROP TRIGGER {trigger} ON {name}"), &[]).await.unwrap();
            seed.exec(&format!("DROP FUNCTION {function}()"), &[]).await.unwrap();
            let after = catalog.table_page(&table, 10, 0).await.unwrap();
            let current = tool_db::GridQueryResult { columns: after.result.columns.clone(), rows: vec![after.result.rows[1].clone()] };
            baseline.check_current(&after.metadata, &current).unwrap();
        }
        catalog.close().await;
        seed.exec(&format!("DROP TABLE {name}"), &[]).await.unwrap();
        physical_fixture::finish_physical_dialect(db, seed, dialect, "finished").await;
    }
    std::fs::remove_file(path).unwrap();
    assert!(!commit_rejection_misclassified, "explicit PostgreSQL constraint rejection must not be indeterminate");
}

async fn assert_current_row(catalog: &mut CatalogConnection, table: &TableRef, snapshot: &RowSnapshot) {
    let page = catalog.table_page(table, 1, 0).await.unwrap();
    snapshot.check_current(&page.metadata, &page.result).unwrap();
}

fn cancel_after_apply(flag: &Arc<AtomicBool>) -> Arc<dyn Fn(MutationPhase) + Send + Sync> {
    cancel_at_phase(flag, MutationPhase::Applied)
}

fn cancel_at_phase(flag: &Arc<AtomicBool>, target: MutationPhase) -> Arc<dyn Fn(MutationPhase) + Send + Sync> {
    let flag = flag.clone();
    Arc::new(move |phase| {
        if phase == target {
            flag.store(true, Ordering::SeqCst)
        }
    })
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("row_mutation": mutation_phases_follow_the_transaction)
}
