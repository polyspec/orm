//! Checks the public statement runner on SQLite, MySQL, and PostgreSQL (INT-150). `db.utils().run(fn)` calls fn with a
//! transaction frame of the connection: outside a transaction it opens one and ends it without retry, inside a transaction
//! it joins the active one. `frame.run(kind, tables, sql, params)` runs one statement, records one statement event (INT-77),
//! returns the statement result with its rows, and never opens a transaction. Each case runs in its own case database
//! (polyspec-orm-case-database) and fails if ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is missing.
//! Requirements: INT-150, INT-77.

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

use std::sync::{Arc, Mutex};

use polyspec_orm::{Config, Db, StatementEvent, Subscription, Val};
use polyspec_orm_case_database::CaseDatabase;

use polyspec_orm_test_support::feature_database;

/// The kinds and SQL of the statement events of the connection, in order.
type Log = Arc<Mutex<Vec<(String, String)>>>;

/// Records every statement event of the connection into `log`.
fn record(db: &Db, log: &Log) -> Subscription {
    let log = Arc::clone(log);
    db.subscribe(move |e: &StatementEvent<'_>| {
        log.lock().unwrap().push((e.kind.to_owned(), e.sql.to_owned()));
        Ok(())
    })
    .or_panic(|e| format!("subscribe: {e}"))
}

/// The number of events whose statement is `SELECT 1` recorded since `from`, which are the frame's own statements.
fn selects_since(log: &Log, from: usize) -> usize {
    log.lock().unwrap()[from..].iter().filter(|(_, sql)| sql == "SELECT 1").count()
}

/// The number of events of `kind` recorded since `from`.
fn count_since(log: &Log, from: usize, kind: &str) -> usize {
    log.lock().unwrap()[from..].iter().filter(|(k, _)| k == kind).count()
}

/// The first value of the first row of a result, as an integer.
fn first_int(rows: &[Vec<Val>]) -> Option<i64> {
    match rows.first()?.first()? {
        Val::I64(n) => Some(*n),
        _ => None,
    }
}

// Runs the statement runner of INT-150 on one database: each case runs in a new case database of that database.
async fn run_driver(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = Db::connect(database.dsn(), 1, Config::default()).await.or_panic(|e| format!("{driver}: connect: {e}"));
    let log: Log = Arc::new(Mutex::new(Vec::new()));
    let _recording = record(&db, &log);

    // Outside a transaction, utils().run opens one, runs the statement in it, and ends it.
    let before = log.lock().unwrap().len();
    let rows = db
        .utils()
        .run(async |frame| frame.run("utility", &[], "SELECT 1", &[]).await)
        .await
        .or_panic(|e| format!("{driver}: utils().run outside a transaction: {e}"));
    assert_eq!(first_int(&rows), Some(1), "{driver}: SELECT 1 outside a transaction");
    assert_eq!(count_since(&log, before, "begin"), 1, "{driver}: the frame opens one transaction");
    assert_eq!(count_since(&log, before, "commit"), 1, "{driver}: the frame ends the transaction it opened");
    assert_eq!(selects_since(&log, before), 1, "{driver}: the frame records its statement once");

    // Inside a transaction, utils().run joins it: no second begin and no commit of its own.
    let before = log.lock().unwrap().len();
    let inside = db
        .transaction(async || {
            let first = db.utils().run(async |frame| frame.run("utility", &[], "SELECT 1", &[]).await).await?;
            let second = db.utils().run(async |frame| frame.run("utility", &[], "SELECT 1", &[]).await).await?;
            Ok::<_, polyspec_orm::Error>((first, second))
        })
        .retry(0)
        .await
        .or_panic(|e| format!("{driver}: utils().run inside a transaction: {e}"));
    assert_eq!(first_int(&inside.0), Some(1), "{driver}: SELECT 1 inside a transaction");
    assert_eq!(first_int(&inside.1), Some(1), "{driver}: second SELECT 1 inside a transaction");
    assert_eq!(count_since(&log, before, "begin"), 1, "{driver}: the joined frames open no transaction of their own");
    assert_eq!(count_since(&log, before, "commit"), 1, "{driver}: the outer transaction commits once");
    assert_eq!(selects_since(&log, before), 2, "{driver}: each joined frame records its statement once");

    // A statement that fails returns its database error code, which is not CONFIG.
    let failed = db.utils().run(async |frame| frame.run("utility", &["statement_runner_missing"], "SELECT * FROM statement_runner_missing", &[]).await).await;
    match failed {
        Ok(_) => panic!("{driver}: a statement on a missing table succeeded"),
        Err(e) => assert_ne!(e.code(), "CONFIG", "{driver}: a failing statement is its database error, not CONFIG"),
    }

    db.close().await;
    database.drop().await;
}

// Requirements: INT-150, INT-77.
async fn statement_runner() {
    for driver in ["sqlite", "mysql", "postgres"] {
        run_driver(driver).await;
    }
}

// statement_runner coverage: runs the statement runner on the database that feature-check selected (ORM_FEATURE_DATABASE).
// The bench database is neither read nor written.
// Requirements: INT-150.
async fn coverage_statement_runner() {
    run_driver(feature_database::selected()).await;
}

fn main() {
    let mut trials = vec![polyspec_orm_testcase::async_trial("statement_runner", polyspec_orm_testcase::DATABASE, statement_runner)];
    trials.push(
        polyspec_orm_testcase::async_trial("coverage_statement_runner", polyspec_orm_testcase::DATABASE, coverage_statement_runner).with_ignored_flag(true),
    );
    polyspec_orm_testcase::run_in_order(trials);
}
