//! The test statement fault on SQLite, MySQL and PostgreSQL
//! (contracts/fixtures/statement_fault.json, protocol section 3.2). The next
//! statement of a connection is not sent; the client reports it as the ORM error
//! with the fixture code and message at the statement end of a driver error.
//! The fault is consumed by that statement, transaction control statements do not
//! consume it, and an empty code or message is refused and arms nothing.
//!
//! The cases run in case databases of their own (polyspec-orm-case-database),
//! reached through ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN. The test fails
//! when one of those variables is unset; no case skips.
//!
//! The entry point `polyspec_orm::testing::fail_next_statement` exists only with
//! the feature `test-faults`:
//! `cargo test -p polyspec-orm --features test-faults --test statement_fault`.

use std::time::Duration;

use polyspec_orm::{Core, Db, Entity, Model, Param, Schema, Val};
use polyspec_orm_case_database::CaseDatabase;
use serde::Deserialize;

/// The fixture of the cases: the code, the message and the case names.
#[derive(Deserialize)]
struct Fixture {
    code: String,
    message: String,
    cases: Vec<String>,
}

const FIXTURE_JSON: &str = include_str!("../../../../contracts/fixtures/statement_fault.json");
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

// The schema is the probe table of contracts/fixtures/rollback.dbs, the same
// document set that the rollback test installs.
static PROBE_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/rollback.dbs"), "sha256:c57c6748bed0458f6d9843a0e0861ca8ea89c3bde5c4308f2e049b6a87a1203c");
static PROBE: Entity = Entity {
    name: "rollback_probe",
    schema: &PROBE_SCHEMA,
    new: polyspec_orm::model::new_boxed::<Probe>,
    collect: polyspec_orm::model::collect_boxed::<Probe>,
};
const COLUMNS: [&str; 2] = ["seq", "label"];

#[derive(Clone)]
struct Probe {
    core: Core,
    values: std::collections::BTreeMap<String, Val>,
}

impl Model for Probe {
    fn entity() -> &'static Entity {
        &PROBE
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        Probe { core, values: std::collections::BTreeMap::new() }
    }
    fn into_core(self) -> Core {
        self.core
    }
    fn assign(&mut self, name: &str, v: Val) -> polyspec_orm::Result<bool> {
        if !COLUMNS.contains(&name) {
            return Ok(false);
        }
        self.values.insert(name.to_owned(), v);
        Ok(true)
    }
    fn value(&self, name: &str) -> Option<Val> {
        self.values.get(name).cloned()
    }
}

fn connected(db: &Db) -> Probe {
    let mut core = Core::new(&PROBE);
    core.connect(db);
    Probe::from_core(core)
}

/// Opens the client and installs the probe table.
async fn installed(driver: &str, dsn: &str) -> Db {
    let db = Db::connect(dsn, 2, polyspec_orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
    db.utils().schema().install(&PROBE_SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    db
}

/// Inserts one probe row through the connection of `db`.
async fn create(db: &Db, label: &str) -> polyspec_orm::Result<()> {
    let mut row = connected(db);
    row.core_mut().set("label", Param::from(label));
    polyspec_orm::model::create(&mut row).await.map(|_| ())
}

async fn count(db: &Db) -> i64 {
    polyspec_orm::model::get_count(connected(db).core()).await.unwrap()
}

/// Checks the error of a refused statement: its code and message are the fixture's.
#[cfg(feature = "test-faults")]
fn check_fault(driver: &str, error: &polyspec_orm::Error, subject: &str) {
    let fixture = fixture();
    assert_eq!(error.code(), fixture.code, "{driver}: {subject}: code of {error}");
    assert!(error.to_string().contains(&fixture.message), "{driver}: {subject}: message of {error} does not name {:?}", fixture.message);
}

/// The next insert is refused: the client reports the fixture error and the table is unchanged.
#[cfg(feature = "test-faults")]
async fn refused_insert(driver: &str, dsn: &str) {
    let fixture = fixture();
    let db = installed(driver, dsn).await;
    polyspec_orm::testing::fail_next_statement(&db, &fixture.code, &fixture.message);
    let error = create(&db, "refused").await.expect_err("the insert is refused");
    check_fault(driver, &error, "insert");
    assert_eq!(count(&db).await, 0, "{driver}: the refused insert leaves the table unchanged");
    db.close().await;
}

/// The fault is consumed by one statement: the insert after the refused one runs.
#[cfg(feature = "test-faults")]
async fn consumed_by_one_statement(driver: &str, dsn: &str) {
    let fixture = fixture();
    let db = installed(driver, dsn).await;
    polyspec_orm::testing::fail_next_statement(&db, &fixture.code, &fixture.message);
    let error = create(&db, "refused").await.expect_err("the insert is refused");
    check_fault(driver, &error, "first insert");
    create(&db, "kept").await.unwrap_or_else(|e| panic!("{driver}: the second insert after the consumed fault: {e}"));
    create(&db, "kept again").await.unwrap_or_else(|e| panic!("{driver}: the third insert: {e}"));
    assert_eq!(count(&db).await, 2, "{driver}: only the two accepted inserts are stored");
    db.close().await;
}

/// Inside a transaction the fault refuses the insert; the transaction control
/// statements before it do not consume the fault. The rollback succeeds, so the
/// error is the fixture error and not ROLLBACK.
#[cfg(feature = "test-faults")]
async fn refused_in_transaction(driver: &str, dsn: &str) {
    let fixture = fixture();
    let db = installed(driver, dsn).await;
    polyspec_orm::testing::fail_next_statement(&db, &fixture.code, &fixture.message);
    let error = db
        .transaction(async || create(&db, "refused").await)
        .retry(0)
        .await
        .expect_err("the transaction with the refused insert");
    assert!(!matches!(error, polyspec_orm::Error::Rollback { .. }), "{driver}: the rollback succeeds, so the error is not ROLLBACK: {error}");
    check_fault(driver, &error, "transaction");
    assert_eq!(count(&db).await, 0, "{driver}: the refused transaction stores no row");
    db.close().await;
}

/// An empty code or an empty message panics (the programmer-error signal of
/// Rust) and arms nothing: the next insert runs.
#[cfg(feature = "test-faults")]
async fn empty_argument_refused(driver: &str, dsn: &str) {
    let fixture = fixture();
    let db = installed(driver, dsn).await;
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        polyspec_orm::testing::fail_next_statement(&db, "", &fixture.message)
    }));
    assert!(refused.is_err(), "{driver}: an empty code panics");
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        polyspec_orm::testing::fail_next_statement(&db, &fixture.code, "")
    }));
    assert!(refused.is_err(), "{driver}: an empty message panics");
    create(&db, "kept").await.unwrap_or_else(|e| panic!("{driver}: a refused arming leaves the next insert running: {e}"));
    assert_eq!(count(&db).await, 1, "{driver}: the insert ran");
    db.close().await;
}

/// Runs one case in its own case database within its deadline, then drops the database.
#[cfg(feature = "test-faults")]
async fn bounded(driver: &str, case: &str) {
    let case = named_case(case);
    let database = CaseDatabase::create(driver).await;
    let dsn = database.dsn();
    let run = async {
        match case.as_str() {
            "refused_insert" => refused_insert(driver, dsn).await,
            "consumed_by_one_statement" => consumed_by_one_statement(driver, dsn).await,
            "refused_in_transaction" => refused_in_transaction(driver, dsn).await,
            "empty_argument_refused" => empty_argument_refused(driver, dsn).await,
            other => unreachable!("unknown case {other}"),
        }
    };
    tokio::time::timeout(CASE_DEADLINE, run).await.unwrap_or_else(|_| panic!("{driver}: {case}: timeout after {CASE_DEADLINE:?}"));
    database.drop().await;
}

/// Guard: every case the fixture names has a test function for each driver in
/// this file, so no named case is left without a run.
#[test]
fn every_fixture_case_has_a_test_per_driver() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let source = include_str!("statement_fault.rs");
    for case in fixture().cases {
        for driver in ["sqlite", "mysql", "postgres"] {
            let function = format!("async fn {case}_{driver}()");
            assert!(source.contains(&function), "statement_fault.json names {case}, but the test {function} is missing");
        }
    }
}

/// Every fixture case on SQLite, MySQL and PostgreSQL, reported as one line `statement-fault/<case>`: a case
/// passes when it passes on every database. A panic in one database run is caught, and its message becomes
/// the reason of the FAIL line.
#[cfg(feature = "test-faults")]
#[tokio::test]
async fn statement_fault_cases() {
    let _test = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    for case in fixture().cases {
        let mut report = polyspec_orm_testcase::start(format!("statement-fault/{case}"), CASE_DEADLINE * 3);
        for driver in ["sqlite", "mysql", "postgres"] {
            let outcome = futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(bounded(driver, &case))).await;
            if let Err(payload) = outcome {
                report.fail(format!("{driver}: {}", panic_reason(payload)));
                break;
            }
        }
    }
}

/// The reason of a caught panic: its message.
#[cfg(feature = "test-faults")]
fn panic_reason(payload: Box<dyn std::any::Any + Send>) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|text| text.to_string()))
        .unwrap_or_else(|| "the run panicked".to_string())
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn refused_insert_sqlite() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    bounded("sqlite", "refused_insert").await;
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn refused_insert_mysql() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    bounded("mysql", "refused_insert").await;
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn refused_insert_postgres() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    bounded("postgres", "refused_insert").await;
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn consumed_by_one_statement_sqlite() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    bounded("sqlite", "consumed_by_one_statement").await;
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn consumed_by_one_statement_mysql() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    bounded("mysql", "consumed_by_one_statement").await;
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn consumed_by_one_statement_postgres() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    bounded("postgres", "consumed_by_one_statement").await;
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn refused_in_transaction_sqlite() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    bounded("sqlite", "refused_in_transaction").await;
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn refused_in_transaction_mysql() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    bounded("mysql", "refused_in_transaction").await;
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn refused_in_transaction_postgres() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    bounded("postgres", "refused_in_transaction").await;
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn empty_argument_refused_sqlite() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    bounded("sqlite", "empty_argument_refused").await;
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn empty_argument_refused_mysql() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    bounded("mysql", "empty_argument_refused").await;
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn empty_argument_refused_postgres() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    bounded("postgres", "empty_argument_refused").await;
}
