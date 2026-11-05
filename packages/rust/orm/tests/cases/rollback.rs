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

use std::time::Duration;

use polyspec_orm::{Core, Db, Entity, Model, Param, Schema};
use polyspec_orm_case_database::CaseDatabase;

static ROLLBACK_SCHEMA: Schema =
    Schema::new(include_str!("../../../../../contracts/fixtures/rollback.dbs"), "sha256:c57c6748bed0458f6d9843a0e0861ca8ea89c3bde5c4308f2e049b6a87a1203c");
static ROLLBACK_PROBE: Entity = Entity {
    name: "rollback_probe",
    schema: &ROLLBACK_SCHEMA,
    new: polyspec_orm::model::new_boxed::<RollbackProbe>,
    collect: polyspec_orm::model::collect_boxed::<RollbackProbe>,
};
const COLUMNS: [&str; 2] = ["seq", "label"];
const CASE_DEADLINE: Duration = Duration::from_secs(30);

model_row!(RollbackProbe, ROLLBACK_PROBE, COLUMNS);

/// Opens the client and installs the fixture.
async fn installed(driver: &str, dsn: &str) -> Db {
    let db = Db::connect(dsn, 2, polyspec_orm::Config::default()).await.or_panic(|e| format!("{driver}: {e}"));
    db.utils().schema().install(&ROLLBACK_SCHEMA).await.or_panic(|e| format!("{driver}: install: {e}"));
    db
}

async fn create(label: &str) -> polyspec_orm::Result<()> {
    let mut row = RollbackProbe::from_core(Core::new(&ROLLBACK_PROBE));
    row.core_mut().set("label", Param::from(label));
    polyspec_orm::model::create(&mut row).await.map(|_| ())
}

/// Checks a ROLLBACK error: it keeps the callback error and the rollback
/// error, and its message names both. Returns the callback error.
fn check_rollback<'e>(driver: &str, error: &'e polyspec_orm::Error, subject: &str) -> &'e polyspec_orm::Error {
    let polyspec_orm::Error::Rollback { callback, rollback } = error else { panic!("{driver}: {subject} = {error}, want ROLLBACK") };
    assert_eq!(error.code(), "ROLLBACK", "{driver}: {subject}");
    let text = error.to_string();
    assert!(text.contains(&callback.to_string()) && text.contains(&rollback.to_string()), "{driver}: {subject} message does not name both errors: {text}");
    callback
}

/// The callback error of a rollback fault case.
fn fault_callback() -> polyspec_orm::Error {
    polyspec_orm::Error::Config("rollback fault callback failed".into())
}

/// The ROLLBACK error of a rollback fault carries the callback error and the FAULT error;
/// this is checked.
fn check_fault(driver: &str, error: &polyspec_orm::Error, subject: &str) {
    let callback = check_rollback(driver, error, subject);
    assert_eq!(callback.to_string(), fault_callback().to_string(), "{driver}: {subject}: callback error");
    let polyspec_orm::Error::Rollback { rollback, .. } = error else { unreachable!() };
    assert_eq!(rollback.code(), "FAULT", "{driver}: {subject}: rollback error {rollback}");
}

/// The rollback fault of the test entry point on the two forms of this crate. A committed transaction
/// leaves the fault in place; `transaction_send` and `transaction_once` then report it with the callback
/// error as `transaction` does (INT-72), and consume it.
async fn transaction_forms_rollback_fault(driver: &str, dsn: &str) {
    let db = installed(driver, dsn).await;
    polyspec_orm::testing::fail_next_rollback(&db);
    db.transaction(async || create("committed").await).retry(0).await.or_panic(|e| format!("{driver}: a committed transaction with an armed fault: {e}"));
    let count = async || polyspec_orm::model::get_count(connected::<RollbackProbe>(&db).core()).await.unwrap();

    let error = db
        .transaction_send(|| async {
            create("rolled back").await?;
            Err::<(), _>(fault_callback())
        })
        .retry(0)
        .await
        .expect_err("transaction_send");
    check_fault(driver, &error, "transaction_send");

    polyspec_orm::testing::fail_next_rollback(&db);
    let error = db
        .transaction_once(async || -> Result<(), std::io::Error> {
            create("rolled back").await.map_err(std::io::Error::other)?;
            Err(std::io::Error::other("rollback fault callback failed"))
        })
        .await
        .expect_err("transaction_once");
    match error {
        polyspec_orm::TransactionOnceError::Rollback { callback, rollback } => {
            assert_eq!(callback.to_string(), "rollback fault callback failed", "{driver}: transaction_once callback error");
            assert_eq!(rollback.code(), "FAULT", "{driver}: transaction_once rollback error {rollback}");
        }
        other => panic!("{driver}: transaction_once = {other}, want Rollback"),
    }
    assert_eq!(count().await, 1, "{driver}: the faulted rollbacks keep only the committed row");
    db.close().await;
}

/// Runs the case within its deadline in its own case database, and drops the database when done.
async fn bounded(driver: &str, case: &str) {
    let database = CaseDatabase::create(driver).await;
    let dsn = database.dsn().to_owned();
    let run = async {
        match case {
            "transaction_forms_rollback_fault" => transaction_forms_rollback_fault(driver, &dsn).await,
            other => unreachable!("unknown case {other}"),
        }
    };
    run_case(database, driver, case, CASE_DEADLINE, run).await;
}

#[tokio::main(flavor = "current_thread")]
// Requirements: INT-72a.
async fn transaction_forms_rollback_fault_sqlite() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    bounded("sqlite", "transaction_forms_rollback_fault").await;
}

#[tokio::main(flavor = "current_thread")]
// Requirements: INT-72a.
async fn transaction_forms_rollback_fault_mysql() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    bounded("mysql", "transaction_forms_rollback_fault").await;
}

#[tokio::main(flavor = "current_thread")]
// Requirements: INT-72a.
async fn transaction_forms_rollback_fault_postgres() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    bounded("postgres", "transaction_forms_rollback_fault").await;
}

/// The test entry point exists only when feature `test-faults` is enabled, and no
/// default feature enables it.
/// Requirements: PRT-44, PRT-54, PRT-59.
fn rollback_fault_entry() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let manifest = std::fs::read_to_string(polyspec_orm_testcase::manifest_dir().join("../orm/Cargo.toml")).unwrap();
    let features = manifest.split("[features]").nth(1).expect("the crate declares its features").split("\n[").next().unwrap();
    assert!(features.contains("test-faults = []"), "the crate declares the feature test-faults: {features}");
    let default = features.lines().find(|line| line.trim_start().starts_with("default"));
    assert!(default.is_none_or(|line| !line.contains("test-faults")), "a default feature enables test-faults: {default:?}");
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("rollback": transaction_forms_rollback_fault_sqlite, transaction_forms_rollback_fault_mysql, transaction_forms_rollback_fault_postgres, rollback_fault_entry)
}
