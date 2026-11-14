//! The rollback fault of the test entry point (contracts/fixtures/rollback.dbs). The failed rollbacks of CFG-15 and
//! INT-155 are cases of contracts/fixtures/transactions/transactions.json.
//!
//! The `rollback_fault_*` cases set the rollback fault of the test entry point `polyspec_orm::testing`.
//! That entry point is built with feature `test-faults`, which the dev-dependency of this crate on
//! itself enables for every test target (Cargo.toml): `cargo test -p polyspec-orm --test rollback`.

use model_connect::connected;
use polyspec_orm_test_support::model_connect;
use polyspec_orm_test_support::model_row;

use crate::or_panic;
use or_panic::OrPanic;

use crate::case_database_run;
use case_database_run::run_case;

use polyspec_orm::{Core, Db, Entity, Model, Param, Schema};
use polyspec_orm_case_database::CaseDatabase;

static ROLLBACK_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/rollback.dbs"), "sha256:c57c6748bed0458f6d9843a0e0861ca8ea89c3bde5c4308f2e049b6a87a1203c");
static ROLLBACK_PROBE: Entity = Entity {
    name: "rollback_probe",
    schema: &ROLLBACK_SCHEMA,
    new: polyspec_orm::model::new_boxed::<RollbackProbe>,
    collect: polyspec_orm::model::collect_boxed::<RollbackProbe>,
};
const COLUMNS: [&str; 2] = ["seq", "label"];

model_row!(RollbackProbe, ROLLBACK_PROBE, COLUMNS);

/// Opens the client and installs the fixture.
async fn installed(driver: &str, dsn: &str) -> Db {
    let db = Db::connect(dsn, 2, polyspec_orm::Config::default()).await.or_panic(|e| format!("{driver}: {e}"));
    db.utils().schema().install(&ROLLBACK_SCHEMA).await.or_panic(|e| format!("{driver}: install: {e}"));
    db
}

async fn create(tx: &polyspec_orm::Tx, label: &str) -> polyspec_orm::Result<()> {
    let mut row = RollbackProbe::from_core(Core::new(&ROLLBACK_PROBE));
    row.core_mut().connect(tx);
    row.core_mut().set("label", Param::from(label));
    polyspec_orm::model::create(&mut row).await.map(|_| ())
}

/// Checks a ROLLBACK error: it keeps the callback error and the rollback
/// error, and its message names both. Returns the callback error.
fn check_rollback<'e>(driver: &str, error: &'e polyspec_orm::Error, subject: &str) -> &'e polyspec_orm::Error {
    assert_eq!(error.kind(), polyspec_orm::Kind::RollbackFailed, "{driver}: {subject} = {error}");
    let (Some(polyspec_orm::CallbackFailure::Kind(callback)), Some(rollback)) = (error.callback_error(), error.rollback_error()) else {
        panic!("{driver}: {subject} = {error}, want rollback_failed with both errors")
    };
    let text = error.to_string();
    assert!(text.contains(&rollback.to_string()), "{driver}: {subject} message does not name the rollback error: {text}");
    callback
}

/// The callback error of a rollback fault case.
fn fault_callback() -> polyspec_orm::Error {
    polyspec_orm::Error::config("rollback fault callback failed")
}

/// The ROLLBACK error of a rollback fault carries the callback error and the FAULT error;
/// this is checked.
fn check_fault(driver: &str, error: &polyspec_orm::Error, subject: &str) {
    let callback = check_rollback(driver, error, subject);
    assert_eq!(callback.to_string(), fault_callback().to_string(), "{driver}: {subject}: callback error");
    let rollback = error.rollback_error().unwrap_or_else(|| unreachable!());
    assert_eq!(rollback.kind(), polyspec_orm::Kind::Fault, "{driver}: {subject}: rollback error {rollback}");
}

/// The rollback fault of the test entry point. A committed transaction leaves the fault in place; a transaction whose
/// callback fails then reports it as `rollback_failed` with the callback error (CORE-25), and consumes it.
async fn transaction_forms_rollback_fault(driver: &str, dsn: &str) {
    let db = installed(driver, dsn).await;
    let once = || polyspec_orm::TransactionOptions { retry: Some(0), ..Default::default() };
    polyspec_orm::testing::fail_next_rollback(&db);
    db.transaction(|tx: polyspec_orm::Tx| async move { create(&tx, "committed").await }, once())
        .await
        .or_panic(|e| format!("{driver}: a committed transaction with an armed fault: {e}"));
    let count = async || polyspec_orm::model::get_count(connected::<RollbackProbe>(&db).core()).await.unwrap();

    let error = db
        .transaction(
            |tx: polyspec_orm::Tx| async move {
                create(&tx, "rolled back").await?;
                Err::<(), _>(fault_callback())
            },
            once(),
        )
        .await
        .expect_err("transaction");
    check_fault(driver, &error, "transaction");
    polyspec_orm::testing::fail_next_rollback(&db);
    db.transaction(|_tx: polyspec_orm::Tx| async move { Ok(()) }, once()).await.or_panic(|e| format!("{driver}: a committed transaction: {e}"));
    let error = db.transaction(|_tx: polyspec_orm::Tx| async move { Err::<(), _>(fault_callback()) }, once()).await.expect_err("second");
    check_fault(driver, &error, "transaction after a commit");
    assert_eq!(count().await, 1, "{driver}: the faulted rollbacks keep only the committed row");
    db.close().await;
}

/// Runs the case in its own case database, and drops the database when done.
async fn bounded(driver: &str, case: &str) {
    let database = CaseDatabase::create(driver).await;
    let dsn = database.dsn().to_owned();
    let run = async {
        match case {
            "transaction_forms_rollback_fault" => transaction_forms_rollback_fault(driver, &dsn).await,
            other => unreachable!("unknown case {other}"),
        }
    };
    run_case(database, run).await;
}

#[tokio::main(flavor = "current_thread")]
// Requirements: INT-190.
async fn transaction_forms_rollback_fault_sqlite() {
    let _case = polyspec_orm_testcase::case!();
    bounded("sqlite", "transaction_forms_rollback_fault").await;
}

#[tokio::main(flavor = "current_thread")]
// Requirements: INT-190.
async fn transaction_forms_rollback_fault_mysql() {
    let _case = polyspec_orm_testcase::case!();
    bounded("mysql", "transaction_forms_rollback_fault").await;
}

#[tokio::main(flavor = "current_thread")]
// Requirements: INT-190.
async fn transaction_forms_rollback_fault_postgres() {
    let _case = polyspec_orm_testcase::case!();
    bounded("postgres", "transaction_forms_rollback_fault").await;
}

/// The test entry point exists only when feature `test-faults` is enabled, and no
/// default feature enables it.
/// Requirements: PRT-44, PRT-54, PRT-59.
fn rollback_fault_entry() {
    let _case = polyspec_orm_testcase::case!();
    let manifest = std::fs::read_to_string(polyspec_orm_testcase::manifest_dir().join("../Cargo.toml")).unwrap();
    let features = manifest.split("[features]").nth(1).expect("the crate declares its features").split("\n[").next().unwrap();
    assert!(features.contains("test-faults = []"), "the crate declares the feature test-faults: {features}");
    let default = features.lines().find(|line| line.trim_start().starts_with("default"));
    assert!(default.is_none_or(|line| !line.contains("test-faults")), "a default feature enables test-faults: {default:?}");
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("rollback": transaction_forms_rollback_fault_sqlite, transaction_forms_rollback_fault_mysql, transaction_forms_rollback_fault_postgres, rollback_fault_entry)
}
