//! The refusal of an empty argument of the test statement fault on SQLite, MySQL and PostgreSQL
//! (contracts/fixtures/statement_fault.json, protocol section 3.2): an empty code or message panics, the
//! programmer-error signal of Rust, and arms nothing. The refused statement, its event and its consumption
//! are the cases a_statement_fault_* of the recipe transactions.
//!
//! The cases run in case databases of their own (polyspec-orm-case-database),
//! reached through ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN. The test fails
//! when one of those variables is unset; no case skips.
//!
//! The entry point `polyspec_orm::testing::fail_next_statement` is built with the
//! feature `test-faults`, which the dev-dependency of this crate on itself enables
//! for every test target (Cargo.toml), so `cargo test -p polyspec-orm --test statement_fault` runs the cases.

use model_connect::connected;
use polyspec_orm_test_support::model_connect;
use polyspec_orm_test_support::rollback_probe;
use rollback_probe::{Probe, PROBE_SCHEMA};

use crate::or_panic;
use or_panic::OrPanic;

use crate::case_database_run;
use case_database_run::run_case;

use std::time::Duration;

use polyspec_orm::{Db, Model, Param};
use polyspec_orm_case_database::CaseDatabase;
use serde::Deserialize;

/// The fixture of the cases: the code, the message and the case names.
#[derive(Deserialize)]
struct Fixture {
    code: String,
    message: String,
    cases: Vec<String>,
}

const FIXTURE_JSON: &str = include_str!("../../../../../contracts/fixtures/statement_fault.json");
const CASE_DEADLINE: Duration = Duration::from_secs(30);

fn fixture() -> Fixture {
    serde_json::from_str(FIXTURE_JSON).expect("contracts/fixtures/statement_fault.json parses")
}

/// Returns the fixture case name, or fails when the case is not named in the fixture.
fn named_case(case: &str) -> String {
    let fixture = fixture();
    assert!(fixture.cases.iter().any(|c| c == case), "statement_fault.json does not name the case {case}");
    case.to_owned()
}

/// Opens the client and installs the probe table.
async fn installed(driver: &str, dsn: &str) -> Db {
    let db = Db::connect(dsn, 2, polyspec_orm::Config::default()).await.or_panic(|e| format!("{driver}: {e}"));
    db.utils().schema().install(&PROBE_SCHEMA).await.or_panic(|e| format!("{driver}: install: {e}"));
    db
}

/// Inserts one probe row through the connection of `db`.
async fn create(db: &Db, label: &str) -> polyspec_orm::Result<()> {
    let mut row = connected::<Probe>(db);
    row.core_mut().set("label", Param::from(label));
    polyspec_orm::model::create(&mut row).await.map(|_| ())
}

async fn count(db: &Db) -> i64 {
    polyspec_orm::model::get_count(connected::<Probe>(db).core()).await.unwrap()
}

/// An empty message panics (the programmer-error signal of Rust) and arms nothing: the next insert runs. The fault takes a
/// kind, so an empty code cannot be written; the code of the fixture names a kind (CORE-3).
async fn empty_argument_refused(driver: &str, dsn: &str) {
    let fixture = fixture();
    let db = installed(driver, dsn).await;
    assert!(!fixture.message.is_empty(), "{driver}: the fixture states the message of the fault");
    let Some(kind) = polyspec_orm_test_support::catalog_code::kind_of_code(&fixture.code) else { panic!("{driver}: the code {} names no kind", fixture.code) };
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| polyspec_orm::testing::fail_next_statement(&db, kind, "")));
    assert!(refused.is_err(), "{driver}: an empty message panics");
    create(&db, "kept").await.or_panic(|e| format!("{driver}: a refused arming leaves the next insert running: {e}"));
    assert_eq!(count(&db).await, 1, "{driver}: the insert ran");
    db.close().await;
}

/// Runs one case in its own case database within its deadline, then drops the database.
async fn bounded(driver: &str, case: &str) {
    let case = named_case(case);
    let database = CaseDatabase::create(driver).await;
    let dsn = database.dsn().to_owned();
    let run = async {
        match case.as_str() {
            "empty_argument_refused" => empty_argument_refused(driver, &dsn).await,
            other => unreachable!("unknown case {other}"),
        }
    };
    run_case(database, driver, &case, CASE_DEADLINE, run).await;
}

/// Guard: every case the fixture names has a test function for each driver in
/// this file, so no named case is left without a run.
fn every_fixture_case_has_a_test_per_driver() {
    let source = include_str!("statement_fault.rs");
    for case in fixture().cases {
        for driver in ["sqlite", "mysql", "postgres"] {
            let function = format!("async fn {case}_{driver}()");
            assert!(source.contains(&function), "statement_fault.json names {case}, but the test {function} is missing");
        }
    }
}

/// Every fixture case on SQLite, MySQL and PostgreSQL, each the trial `statement_fault_cases::<case>`: a case
/// passes when it passes on every database. A panic in one database run is caught, and its message fails the case.
fn statement_fault_cases() -> Vec<polyspec_orm_testcase::Trial> {
    fixture()
        .cases
        .into_iter()
        .map(|case| {
            polyspec_orm_testcase::async_trial(format!("statement_fault::statement_fault_cases::{case}"), CASE_DEADLINE * 3, move || async move {
                for driver in ["sqlite", "mysql", "postgres"] {
                    let outcome = futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(bounded(driver, &case))).await;
                    if let Err(payload) = outcome {
                        panic!("{driver}: {}", panic_reason(payload));
                    }
                }
            })
        })
        .collect()
}

/// The reason of a caught panic: its message.
fn panic_reason(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|text| text.to_string()))
        .unwrap_or_else(|| "the run panicked".to_string())
}

async fn empty_argument_refused_sqlite() {
    bounded("sqlite", "empty_argument_refused").await;
}

async fn empty_argument_refused_mysql() {
    bounded("mysql", "empty_argument_refused").await;
}

async fn empty_argument_refused_postgres() {
    bounded("postgres", "empty_argument_refused").await;
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    let mut trials = vec![polyspec_orm_testcase::trial(
        "statement_fault::every_fixture_case_has_a_test_per_driver",
        polyspec_orm_testcase::DATABASE,
        every_fixture_case_has_a_test_per_driver,
    )];
    trials.extend(statement_fault_cases());
    trials.push(polyspec_orm_testcase::async_trial(
        "statement_fault::empty_argument_refused_sqlite",
        polyspec_orm_testcase::DATABASE,
        empty_argument_refused_sqlite,
    ));
    trials.push(polyspec_orm_testcase::async_trial(
        "statement_fault::empty_argument_refused_mysql",
        polyspec_orm_testcase::DATABASE,
        empty_argument_refused_mysql,
    ));
    trials.push(polyspec_orm_testcase::async_trial(
        "statement_fault::empty_argument_refused_postgres",
        polyspec_orm_testcase::DATABASE,
        empty_argument_refused_postgres,
    ));
    trials
}
