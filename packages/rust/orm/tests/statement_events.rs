//! Runs the cases of tests/events/vectors.json with this client on MySQL, PostgreSQL, and SQLite and
//! compares the statement events (docs/usage.md "Statement events"). For each case, its own case
//! database has the fixture contracts/fixtures/statement_events.dbs installed (unless the case's install
//! is false), registers one recording subscriber, then runs the steps in turn. The record
//! holds sql, binds, kind, tables, and transaction (a number recounted from 1 in the order first seen within the case,
//! null outside a transaction), and error (the code of the statement error, or null if none). compare
//! "tables" compares only events that have tables. elapsed is a `Duration`, so it cannot be negative.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use polyspec_orm::core::{Arg, ChainKey};
use polyspec_orm::{Core, Db, Entity, Model, Param, Schema, StatementEvent, Subscription, Val};
use polyspec_orm_case_database::CaseDatabase;
use serde_json::{json, Value};

static EVENTS_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/statement_events.dbs"), "sha256:0f576f8672d1b7c7ad72fa90e88dfcbcfeb41d35efd02cc7afe3ce6765f8b207");
static EVENT_PROBE: Entity = Entity {
    name: "event_probe",
    schema: &EVENTS_SCHEMA,
    new: polyspec_orm::model::new_boxed::<EventProbe>,
    collect: polyspec_orm::model::collect_boxed::<EventProbe>,
};
const COLUMNS: [&str; 2] = ["seq", "label"];
const VECTOR: &str = include_str!("../../../../tests/events/vectors.json");
const CASE_DEADLINE: Duration = Duration::from_secs(60);
const BY_LABEL: &[ChainKey] = &[ChainKey { conn: "", op: "", column: "label", columns: &[], compare: "" }];

#[derive(Clone)]
struct EventProbe {
    core: Core,
    values: std::collections::BTreeMap<String, Val>,
}

impl Model for EventProbe {
    fn entity() -> &'static Entity {
        &EVENT_PROBE
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        EventProbe { core, values: std::collections::BTreeMap::new() }
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

/// The error message of a failing transaction callback.
const CALLBACK_FAILED: &str = "statement events test callback failed";

/// The events collected by the recording subscriber and the recounted transaction numbers.
#[derive(Default)]
struct Recorded {
    records: Vec<Value>,
    numbers: HashMap<u64, u64>,
}

/// The state of running one case.
struct EventRun {
    driver: &'static str,
    db: Db,
    recorded: Arc<Mutex<Recorded>>,
    recording: Mutex<Option<Subscription>>,
    failing: Mutex<Option<Subscription>>,
}

/// Writes bind values as the JSON values of the vector.
fn bind_json(p: &Param) -> Value {
    match p {
        Param::Null => Value::Null,
        Param::Bool(b) => json!(b),
        Param::I64(n) => json!(n),
        Param::F64(x) => json!(x),
        Param::Str(s) => json!(s),
        other => panic!("unexpected bind {other:?}"),
    }
}

/// Records one event.
fn record(recorded: &Mutex<Recorded>, e: &StatementEvent<'_>) {
    let mut r = recorded.lock().unwrap();
    let transaction = e.transaction.map(|n| {
        let next = r.numbers.len() as u64 + 1;
        *r.numbers.entry(n).or_insert(next)
    });
    let binds: Vec<Value> = e.binds.iter().map(bind_json).collect();
    r.records.push(json!({
        "sql": e.sql,
        "binds": binds,
        "kind": e.kind,
        "tables": e.tables,
        "transaction": transaction,
        "error": e.error.map(|error| error.code().to_owned()),
    }));
}

impl EventRun {
    fn model(&self) -> EventProbe {
        let mut core = Core::new(&EVENT_PROBE);
        core.connect(&self.db);
        EventProbe::from_core(core)
    }

    async fn by_label(&self, label: &str) -> polyspec_orm::Result<EventProbe> {
        let filter = self.model().core().by(BY_LABEL, vec![Arg::Value(polyspec_orm::args::Value::One(Param::from(label)))]);
        polyspec_orm::model::get_core::<EventProbe>(&filter).await?.ok_or(polyspec_orm::Error::NoRows)
    }

    /// Runs one step and returns its result.
    fn step<'a>(&'a self, s: &'a Value) -> Pin<Box<dyn Future<Output = polyspec_orm::Result<()>> + 'a>> {
        Box::pin(async move {
            let label = s["label"].as_str().unwrap_or_default();
            match s["op"].as_str().expect("step op") {
                "create" => {
                    let mut row = self.model();
                    row.core_mut().set("label", Param::from(label));
                    polyspec_orm::model::create(&mut row).await.map(|_| ())
                }
                "get" => self.by_label(label).await.map(|_| ()),
                "count" => {
                    let n = polyspec_orm::model::get_count(self.model().core()).await?;
                    if let Some(want) = s["result"].as_i64() {
                        assert_eq!(n, want, "{}: count", self.driver);
                    }
                    Ok(())
                }
                "update" => {
                    let mut row = self.by_label(label).await?;
                    row.core_mut().set("label", Param::from(s["to"].as_str().expect("update to")));
                    polyspec_orm::model::update(&mut row, false).await
                }
                "delete" => {
                    let row = self.by_label(label).await?;
                    polyspec_orm::model::delete(&row, false).await
                }
                "transaction" => {
                    let steps = s["steps"].as_array().cloned().unwrap_or_default();
                    let fail = s["fail"].as_bool().unwrap_or(false);
                    self.db
                        .transaction(async || {
                            for inner in &steps {
                                self.checked(inner).await?;
                            }
                            if fail {
                                return Err(polyspec_orm::Error::Config(CALLBACK_FAILED.into()));
                            }
                            Ok(())
                        })
                        .retry(0)
                        .await
                }
                "install" => self.db.utils().schema().install(&EVENTS_SCHEMA).await,
                "fail_subscriber" => {
                    let kind = s["kind"].as_str().expect("fail_subscriber kind").to_owned();
                    let failing = self.db.subscribe(move |e: &StatementEvent<'_>| {
                        if e.kind == kind {
                            return Err("subscriber refused the event".into());
                        }
                        Ok(())
                    })?;
                    *self.failing.lock().unwrap() = Some(failing);
                    Ok(())
                }
                "stop_failing" => {
                    self.failing.lock().unwrap().take().expect("a failing subscriber").unsubscribe();
                    Ok(())
                }
                "unsubscribe" => {
                    self.recording.lock().unwrap().take().expect("the recording subscriber").unsubscribe();
                    Ok(())
                }
                other => panic!("unknown step {other:?}"),
            }
        })
    }

    /// Runs a step and checks whether its error is the one the step expected. The expected error is not swallowed,
    /// but is returned so that the outer transaction's callback receives it. The callback
    /// error that a transaction step expected is treated as handled in the outer callback.
    async fn checked(&self, s: &Value) -> polyspec_orm::Result<()> {
        let result = self.step(s).await;
        let op = s["op"].as_str().unwrap_or_default();
        match (s["error"].as_str(), result) {
            (None, Ok(())) => Ok(()),
            (None, Err(e)) => panic!("{}: step {op}: {e}", self.driver),
            (Some("callback"), Err(e)) if e.to_string().ends_with(CALLBACK_FAILED) => Ok(()),
            (Some(code), Err(e)) if code != "callback" && e.code() == code => {
                if code == "SUBSCRIBER" {
                    let cause = std::error::Error::source(&e).map(ToString::to_string);
                    assert_eq!(cause.as_deref(), Some("subscriber refused the event"), "{}: SUBSCRIBER keeps the subscriber error as its cause", self.driver);
                }
                Err(e)
            }
            (Some(code), result) => panic!("{}: step {op} = {result:?}, want {code}", self.driver),
        }
    }
}

/// Runs one case in its own case database and compares the recorded events with the vector.
async fn run_case(driver: &'static str, case: &Value) {
    let id = case["id"].as_str().expect("case id");
    let database = CaseDatabase::create(driver).await;
    let run = async {
        let db = Db::connect_schema(database.dsn(), &EVENTS_SCHEMA, 2, polyspec_orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {id}: {e}"));
        if case["install"].as_bool().unwrap_or(true) {
            db.utils().schema().install(&EVENTS_SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: {id}: install: {e}"));
        }
        let recorded = Arc::new(Mutex::new(Recorded::default()));
        let sink = recorded.clone();
        let recording = db
            .subscribe(move |e: &StatementEvent<'_>| {
                record(&sink, e);
                Ok(())
            })
            .unwrap();
        let r = EventRun { driver, db: db.clone(), recorded, recording: Mutex::new(Some(recording)), failing: Mutex::new(None) };
        for s in case["steps"].as_array().expect("case steps") {
            let _ = r.checked(s).await;
        }
        let mut got = std::mem::take(&mut r.recorded.lock().unwrap().records);
        if case["compare"].as_str() == Some("tables") {
            got.retain(|e| e["tables"].as_array().is_some_and(|t| !t.is_empty()));
        }
        let want = case["events"][driver].as_array().cloned().unwrap_or_default();
        assert!(
            got == want,
            "{driver}: {id} events\n got {}\nwant {}",
            serde_json::to_string_pretty(&got).unwrap(),
            serde_json::to_string_pretty(&want).unwrap()
        );
        db.close().await;
    };
    tokio::time::timeout(CASE_DEADLINE, run).await.unwrap_or_else(|_| panic!("{driver}: {id}: timeout after {CASE_DEADLINE:?}"));
    database.drop().await;
}

async fn run_cases(driver: &'static str) {
    let vector: Value = serde_json::from_str(VECTOR).expect("tests/events/vectors.json");
    for case in vector["cases"].as_array().expect("vector cases") {
        polyspec_orm_testcase::step(format_args!("{driver}: case {}", case["id"].as_str().unwrap_or_default()));
        run_case(driver, case).await;
    }
}

/// The cases of tests/events/vectors.json, one trial `statement_events::<case id>` per case, each run on MySQL,
/// PostgreSQL and SQLite in a case database of its own.
fn statement_events() -> Vec<polyspec_orm_testcase::Trial> {
    let vector: Value = serde_json::from_str(VECTOR).expect("tests/events/vectors.json");
    vector["cases"]
        .as_array()
        .expect("vector cases")
        .iter()
        .map(|case| {
            let case = case.clone();
            let id = case["id"].as_str().expect("case id").to_owned();
            polyspec_orm_testcase::async_trial(format!("statement_events::{id}"), polyspec_orm_testcase::DATABASE, move || async move {
                for driver in ["mysql", "postgres", "sqlite"] {
                    polyspec_orm_testcase::step(format_args!("{driver}: case {id}"));
                    run_case(driver, &case).await;
                }
            })
        })
        .collect()
}

/// statement_events coverage: on the database feature-check chose (ORM_FEATURE_DATABASE),
/// runs every case of the vector, each in a new case database. The bench database is neither read nor written.
/// It is an ignored trial, which feature-check runs with --include-ignored.
async fn coverage_statement_events() {
    let driver = match std::env::var("ORM_FEATURE_DATABASE").as_deref() {
        Ok("mysql") => "mysql",
        Ok("postgres") => "postgres",
        Ok("sqlite") => "sqlite",
        _ => panic!("ORM_FEATURE_DATABASE (mysql, postgres or sqlite) is required; run it through make feature-check, which sets it for each coverage case"),
    };
    run_cases(driver).await;
}

/// Runs the vector's server_transactions in a PostgreSQL case database. The number of server transactions counted for one run of a page, which the probe returns,
/// counts the server transactions of one page run from the difference in the backend's local transaction numbers. With pool size
/// 1, all statements run on one backend. The probe sends through sqlx on the same pool, so there are no
/// events for it. sqlx prepares the first statement text it sends on a connection with its own round trip before running it, so
/// if rust is in first_run_prepare_clients, the first run adds the number of statement texts to the event count.
async fn statement_events_server_transactions() {
    let vector: Value = serde_json::from_str(VECTOR).expect("tests/events/vectors.json");
    let spec = &vector["server_transactions"];
    let listed = |key: &str| spec[key].as_array().unwrap_or_else(|| panic!("{key}")).iter().any(|c| c == "rust");
    let (one_per_event, with_prepares) = (listed("first_run_clients"), listed("first_run_prepare_clients"));
    assert!(one_per_event != with_prepares, "rust is in exactly one of first_run_clients and first_run_prepare_clients");
    let page = vector["cases"].as_array().expect("vector cases").iter().find(|c| c["id"] == spec["page"]).expect("server_transactions page is a case");
    let probe_sql = spec["probe"].as_str().expect("probe").to_owned();
    let driver = "postgres";
    assert_eq!(spec["database"], driver, "server_transactions database");
    let database = CaseDatabase::create(driver).await;
    let run = async {
        let setup = Db::connect_schema(database.dsn(), &EVENTS_SCHEMA, 1, polyspec_orm::Config::default()).await.expect("connect");
        setup.utils().schema().install(&EVENTS_SCHEMA).await.expect("install");
        setup.close().await;
        let db = Db::connect_schema(database.dsn(), &EVENTS_SCHEMA, 1, polyspec_orm::Config::default()).await.expect("connect");
        let polyspec_orm::db::Pool::Postgres(pool) = db.pool() else { panic!("postgres pool") };
        let (setting, source): (String, String) =
            sqlx::query_as("SELECT setting, source FROM pg_settings WHERE name = 'TimeZone'").fetch_one(pool).await.expect("TimeZone");
        // Through a pooler, the pooler applies the startup parameters to the server connection with SET, so
        // the source does not name the client. The source is compared only when it reaches the server directly.
        let pooled = std::env::var("ORM_TEST_POSTGRES_DSN").ok() != std::env::var("ORM_TEST_POSTGRES_SERVER_DSN").ok();
        assert_eq!(setting, spec["time_zone"]["setting"], "TimeZone setting");
        if !pooled {
            assert_eq!(source, spec["time_zone"]["source"], "TimeZone source");
        }
        let probe = || async { sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(probe_sql.clone())).fetch_one(pool).await.expect("probe") };
        let first = probe().await;
        let cost = probe().await - first;
        let recorded = Arc::new(Mutex::new(Recorded::default()));
        let sink = recorded.clone();
        let recording = db
            .subscribe(move |e: &StatementEvent<'_>| {
                record(&sink, e);
                Ok(())
            })
            .unwrap();
        let r = EventRun { driver, db: db.clone(), recorded, recording: Mutex::new(Some(recording)), failing: Mutex::new(None) };
        let mut before = probe().await;
        let mut failures = Vec::new();
        for name in ["first", "second"] {
            for s in page["steps"].as_array().expect("page steps") {
                let _ = r.checked(s).await;
            }
            let records = std::mem::take(&mut r.recorded.lock().unwrap().records);
            let events = records.len() as i64;
            let texts = records.iter().map(|e| e["sql"].as_str().unwrap_or_default().to_owned()).collect::<std::collections::BTreeSet<_>>().len() as i64;
            let after = probe().await;
            let transactions = after - before - cost;
            before = after;
            println!("server_transactions {name} run: {events} events, {texts} statement texts, {transactions} transactions");
            let want = if name == "first" && with_prepares { events + texts } else { events };
            if transactions != want {
                failures
                    .push(format!("{name} run spent {transactions} server transactions for {events} statement events of {texts} statement texts, want {want}"));
            }
        }
        db.close().await;
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    };
    tokio::time::timeout(CASE_DEADLINE, run).await.unwrap_or_else(|_| panic!("server_transactions: timeout after {CASE_DEADLINE:?}"));
    database.drop().await;
}

fn main() {
    let mut trials = statement_events();
    trials.push(
        polyspec_orm_testcase::async_trial("coverage_statement_events", polyspec_orm_testcase::DATABASE, coverage_statement_events).with_ignored_flag(true),
    );
    trials.push(polyspec_orm_testcase::async_trial(
        "statement_events_server_transactions",
        polyspec_orm_testcase::DATABASE,
        statement_events_server_transactions,
    ));
    polyspec_orm_testcase::run_in_order(trials);
}
