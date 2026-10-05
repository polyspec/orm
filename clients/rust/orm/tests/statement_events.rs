//! tests/events/vectors.json의 case를 이 client로 MySQL, PostgreSQL, SQLite에서 실행해
//! statement event를 비교한다(docs/usage.md "Statement events"). case마다 자기 case
//! database에 fixture contracts/fixtures/statement_events.dbs를 설치하고(case의 install이
//! false가 아니면) 기록하는 subscriber 하나를 등록한 뒤 step을 차례로 실행한다. 기록은
//! sql, binds, kind, tables, transaction(case 안에서 처음 나온 순서로 1부터 다시 센 번호,
//! transaction 밖이면 null), error(statement 오류의 code, 없으면 null)다. compare가
//! "tables"이면 table을 가진 event만 비교한다. elapsed는 `Duration`이므로 음수가 될 수 없다.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use orm::core::{Arg, ChainKey};
use orm::{Core, Db, Entity, Model, Param, Schema, StatementEvent, Subscription, Val};
use orm_case_database::CaseDatabase;
use serde_json::{json, Value};

static EVENTS_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/statement_events.dbs"), "sha256:0f576f8672d1b7c7ad72fa90e88dfcbcfeb41d35efd02cc7afe3ce6765f8b207");
static EVENT_PROBE: Entity =
    Entity { name: "event_probe", schema: &EVENTS_SCHEMA, new: orm::model::new_boxed::<EventProbe>, collect: orm::model::collect_boxed::<EventProbe> };
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
    fn assign(&mut self, name: &str, v: Val) -> orm::Result<bool> {
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

/// 실패하는 transaction callback의 오류 message다.
const CALLBACK_FAILED: &str = "statement events test callback failed";

/// 기록하는 subscriber가 모은 event와 transaction 번호의 다시 센 번호다.
#[derive(Default)]
struct Recorded {
    records: Vec<Value>,
    numbers: HashMap<u64, u64>,
}

/// case 하나를 실행하는 상태다.
struct EventRun {
    driver: &'static str,
    db: Db,
    recorded: Arc<Mutex<Recorded>>,
    recording: Mutex<Option<Subscription>>,
    failing: Mutex<Option<Subscription>>,
}

/// bind 값을 vector의 JSON 값으로 쓴다.
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

/// event 하나를 기록한다.
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

    async fn by_label(&self, label: &str) -> orm::Result<EventProbe> {
        let filter = self.model().core().by(BY_LABEL, vec![Arg::Value(orm::args::Value::One(Param::from(label)))]);
        orm::model::get_core::<EventProbe>(&filter).await
    }

    /// step 하나를 실행하고 그 결과를 돌려준다.
    fn step<'a>(&'a self, s: &'a Value) -> Pin<Box<dyn Future<Output = orm::Result<()>> + 'a>> {
        Box::pin(async move {
            let label = s["label"].as_str().unwrap_or_default();
            match s["op"].as_str().expect("step op") {
                "create" => {
                    let mut row = self.model();
                    row.core_mut().set("label", Param::from(label));
                    orm::model::create(&mut row).await.map(|_| ())
                }
                "get" => self.by_label(label).await.map(|_| ()),
                "count" => {
                    let n = orm::model::get_count(self.model().core()).await?;
                    if let Some(want) = s["result"].as_i64() {
                        assert_eq!(n, want, "{}: count", self.driver);
                    }
                    Ok(())
                }
                "update" => {
                    let mut row = self.by_label(label).await?;
                    row.core_mut().set("label", Param::from(s["to"].as_str().expect("update to")));
                    orm::model::update(&mut row, false).await
                }
                "delete" => {
                    let row = self.by_label(label).await?;
                    orm::model::delete(&row, false).await
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
                                return Err(orm::Error::Config(CALLBACK_FAILED.into()));
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
                    });
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

    /// step을 실행하고 그 오류가 step이 기대한 것인지 확인한다. 기대한 오류는 삼키지 않고
    /// 돌려주어 바깥 transaction의 callback이 받게 한다. transaction step이 기대한 callback
    /// 오류는 바깥 callback에서 처리된 것으로 본다.
    async fn checked(&self, s: &Value) -> orm::Result<()> {
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

/// case 하나를 자기 case database에서 실행하고 기록한 event를 vector와 비교한다.
async fn run_case(driver: &'static str, case: &Value) {
    let id = case["id"].as_str().expect("case id");
    let database = CaseDatabase::create(driver).await;
    let run = async {
        let db = Db::connect_schema(database.dsn(), &EVENTS_SCHEMA, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {id}: {e}"));
        if case["install"].as_bool().unwrap_or(true) {
            db.utils().schema().install(&EVENTS_SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: {id}: install: {e}"));
        }
        let recorded = Arc::new(Mutex::new(Recorded::default()));
        let sink = recorded.clone();
        let recording = db.subscribe(move |e: &StatementEvent<'_>| {
            record(&sink, e);
            Ok(())
        });
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
        orm_testcase::step(format_args!("{driver}: case {}", case["id"].as_str().unwrap_or_default()));
        run_case(driver, case).await;
    }
}

#[tokio::test]
async fn statement_events_mysql() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    run_cases("mysql").await;
}

#[tokio::test]
async fn statement_events_postgres() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    run_cases("postgres").await;
}

#[tokio::test]
async fn statement_events_sqlite() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    run_cases("sqlite").await;
}

/// statement_events coverage: feature-check가 고른 database(ORM_FEATURE_DATABASE)에서
/// vector의 모든 case를 case마다 새 case database로 실행한다. bench database는 읽거나 쓰지 않는다.
#[tokio::test]
#[ignore = "run by feature-check"]
async fn coverage_statement_events() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    let driver = match std::env::var("ORM_FEATURE_DATABASE").as_deref() {
        Ok("mysql") => "mysql",
        Ok("postgres") => "postgres",
        Ok("sqlite") => "sqlite",
        _ => panic!("ORM_FEATURE_DATABASE (mysql, postgres or sqlite) is required"),
    };
    run_cases(driver).await;
}

/// vector의 server_transactions를 PostgreSQL case database에서 실행한다. probe가 돌려주는
/// backend의 local transaction 번호 차이로 page 실행 한 번의 server transaction을 센다. pool size
/// 1이므로 모든 statement가 한 backend에서 실행된다. probe는 같은 pool에서 sqlx로 보내므로 event가
/// 없다. sqlx는 연결에서 처음 보내는 statement text를 실행 전에 자기 round trip으로 prepare하므로,
/// rust가 first_run_prepare_clients에 있으면 첫 실행은 event 수에 statement text 수를 더한다.
#[tokio::test]
async fn statement_events_server_transactions() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
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
        let setup = Db::connect_schema(database.dsn(), &EVENTS_SCHEMA, 1, orm::Config::default()).await.expect("connect");
        setup.utils().schema().install(&EVENTS_SCHEMA).await.expect("install");
        setup.close().await;
        let db = Db::connect_schema(database.dsn(), &EVENTS_SCHEMA, 1, orm::Config::default()).await.expect("connect");
        let orm::db::Pool::Postgres(pool) = db.pool() else { panic!("postgres pool") };
        let (setting, source): (String, String) =
            sqlx::query_as("SELECT setting, source FROM pg_settings WHERE name = 'TimeZone'").fetch_one(pool).await.expect("TimeZone");
        // pooler를 거치면 pooler가 startup parameter를 server connection에 SET으로 적용하므로
        // source는 client를 말하지 않는다. source는 server에 바로 닿을 때만 비교한다.
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
        let recording = db.subscribe(move |e: &StatementEvent<'_>| {
            record(&sink, e);
            Ok(())
        });
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
