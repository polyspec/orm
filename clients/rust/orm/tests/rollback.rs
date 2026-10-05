//! A transaction or savepoint whose callback fails and whose rollback fails
//! too, on SQLite, MySQL and PostgreSQL (contracts/fixtures/rollback.dbs). The client reports Error::Rollback
//! with the code ROLLBACK, which keeps the callback error and the rollback
//! error. The callback runs only model calls. On SQLite a trigger of the test
//! fixture raises ROLLBACK when a row labeled `end` is inserted, which ends
//! the transaction, so the client's ROLLBACK finds no transaction. On MySQL
//! and PostgreSQL a test connection ends the server session that holds the
//! transaction, so the next statement and the rollback fail; that connection
//! reaches the server through ORM_TEST_MYSQL_SERVER_DSN or
//! ORM_TEST_POSTGRES_SERVER_DSN (the make targets set them to the server DSNs
//! of TEST_ENV), not through a pooler. Each case runs in a case database of its
//! own (orm-case-database). The test fails when one of the four DSNs is unset.
//!
//! `rollback_fault_*` case는 test entry point `orm::testing`의 rollback fault를
//! 설정하며 feature `test-faults`로 실행한다:
//! `cargo test -p orm --features test-faults --test rollback`.

use std::time::Duration;

use orm::db::Pool;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};
use orm_case_database::CaseDatabase;

static ROLLBACK_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/rollback.dbs"), "sha256:c57c6748bed0458f6d9843a0e0861ca8ea89c3bde5c4308f2e049b6a87a1203c");
static ROLLBACK_PROBE: Entity = Entity {
    name: "rollback_probe",
    schema: &ROLLBACK_SCHEMA,
    new: orm::model::new_boxed::<RollbackProbe>,
    collect: orm::model::collect_boxed::<RollbackProbe>,
};
const COLUMNS: [&str; 2] = ["seq", "label"];
const CASE_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct RollbackProbe {
    core: Core,
    values: std::collections::BTreeMap<String, Val>,
}

impl Model for RollbackProbe {
    fn entity() -> &'static Entity {
        &ROLLBACK_PROBE
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        RollbackProbe { core, values: std::collections::BTreeMap::new() }
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

fn connected(db: &Db) -> RollbackProbe {
    let mut core = Core::new(&ROLLBACK_PROBE);
    core.connect(db);
    RollbackProbe::from_core(core)
}

/// Opens the client, installs the fixture and, on SQLite, the trigger that raises ROLLBACK.
async fn installed(driver: &str, dsn: &str) -> Db {
    let db = Db::connect(dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
    db.utils().schema().install(&ROLLBACK_SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    if let Pool::Sqlite(p) = db.pool() {
        sqlx::raw_sql("CREATE TRIGGER rollback_probe_end BEFORE INSERT ON rollback_probe WHEN NEW.label = 'end' BEGIN SELECT RAISE(ROLLBACK, 'rollback probe ended the transaction'); END")
            .execute(p)
            .await
            .unwrap_or_else(|e| panic!("trigger: {e}"));
    }
    db
}

/// Ends the server session that holds a lock on rollback_probe in the case
/// database; SQLite needs none, its trigger ends the transaction. `session`
/// is the case database on the server of ORM_TEST_MYSQL_SERVER_DSN or
/// ORM_TEST_POSTGRES_SERVER_DSN, not on a pooler, because a pooler may handle
/// the statement on its own: ProxySQL takes a text-protocol KILL as a command
/// for its own client sessions. The lock on the table of the case database
/// marks the session that holds the transaction behind the pooler. The test
/// connection is a client connection (`Db::connect`), so it sends the startup
/// parameters of the client and no parameter a pooler rejects.
async fn end_session(driver: &str, session: &str) {
    if driver == "sqlite" {
        return;
    }
    let admin = Db::connect(session, 1, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: session connection: {e}"));
    match admin.pool() {
        Pool::Postgres(pool) => {
            let pid: i32 = sqlx::query_scalar(
                "SELECT l.pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND c.relname = 'rollback_probe' AND l.pid <> pg_backend_pid() LIMIT 1",
            )
            .fetch_one(pool)
            .await
            .expect("the transaction session holds a lock on rollback_probe");
            sqlx::query("SELECT pg_terminate_backend($1, 5000)").bind(pid).execute(pool).await.unwrap();
        }
        Pool::MySql(pool) => {
            let id: u64 = sqlx::query_scalar("SELECT t.PROCESSLIST_ID FROM performance_schema.data_locks l JOIN performance_schema.threads t ON t.THREAD_ID = l.THREAD_ID WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'rollback_probe' LIMIT 1")
                .fetch_one(pool)
                .await
                .expect("the transaction session holds a lock on rollback_probe");
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!("KILL {id}"))).execute(pool).await.unwrap();
        }
        Pool::Sqlite(_) => unreachable!("sqlite needs no session end"),
    }
    admin.close().await;
}

/// The DSN of the case database on the server itself: ORM_TEST_MYSQL_SERVER_DSN
/// or ORM_TEST_POSTGRES_SERVER_DSN with the path of the case database. SQLite
/// has no server; its DSN is the case file.
fn session_dsn(driver: &str, database: &CaseDatabase) -> String {
    if driver == "sqlite" {
        return database.dsn().to_owned();
    }
    let env = format!("ORM_TEST_{}_SERVER_DSN", driver.to_uppercase());
    match std::env::var(&env) {
        Ok(server) if !server.is_empty() => database.related_dsn(&server),
        _ => panic!("{env} is required; database tests never skip; run the test through its make target, which reads the environment of make test-servers"),
    }
}

async fn create(label: &str) -> orm::Result<()> {
    let mut row = RollbackProbe::from_core(Core::new(&ROLLBACK_PROBE));
    row.core_mut().set("label", Param::from(label));
    orm::model::create(&mut row).await.map(|_| ())
}

/// Checks a ROLLBACK error: it keeps the callback error and the rollback
/// error, and its message names both. Returns the callback error.
fn check_rollback<'e>(driver: &str, error: &'e orm::Error, subject: &str) -> &'e orm::Error {
    let orm::Error::Rollback { callback, rollback } = error else { panic!("{driver}: {subject} = {error}, want ROLLBACK") };
    assert_eq!(error.code(), "ROLLBACK", "{driver}: {subject}");
    let text = error.to_string();
    assert!(text.contains(&callback.to_string()) && text.contains(&rollback.to_string()), "{driver}: {subject} message does not name both errors: {text}");
    callback
}

/// The callback of a transaction fails and the rollback fails.
async fn rollback_failed(driver: &str, dsn: &str, session: &str) {
    let db = installed(driver, dsn).await;
    let error = db
        .transaction(async || {
            create("kept").await?;
            end_session(driver, session).await;
            create("end").await
        })
        .await
        .expect_err("transaction");
    let callback = check_rollback(driver, &error, "transaction");
    if driver != "sqlite" {
        // server가 끝낸 session의 다음 statement와 rollback은 연결을 잃은 오류다.
        let orm::Error::Rollback { rollback, .. } = &error else { unreachable!() };
        assert_eq!(callback.code(), orm::codes::CONNECTION_LOST, "{driver}: the callback error is {callback}");
        assert_eq!(rollback.code(), orm::codes::CONNECTION_LOST, "{driver}: the rollback error is {rollback}");
    }
    if driver == "sqlite" {
        assert!(callback.to_string().contains("rollback probe ended the transaction"), "callback error {callback}");
        assert_eq!(orm::model::get_count(connected(&db).core()).await.unwrap(), 0, "the connection serves later requests");
    }
    db.close().await;
}

/// The callback of a savepoint fails and the savepoint rollback fails, and
/// then the transaction rollback fails.
async fn savepoint_rollback_failed(driver: &str, dsn: &str, session: &str) {
    let db = installed(driver, dsn).await;
    let error = db
        .transaction(async || {
            create("kept").await?;
            db.transaction(async || {
                create("nested").await?;
                end_session(driver, session).await;
                create("end").await
            })
            .await
        })
        .await
        .expect_err("transaction");
    let callback = check_rollback(driver, &error, "transaction");
    check_rollback(driver, callback, "savepoint");
    if driver == "sqlite" {
        assert_eq!(orm::model::get_count(connected(&db).core()).await.unwrap(), 0, "the connection serves later requests");
    }
    db.close().await;
}

/// rollback fault case의 callback 오류다.
#[cfg(feature = "test-faults")]
fn fault_callback() -> orm::Error {
    orm::Error::Config("rollback fault callback failed".into())
}

/// rollback fault의 ROLLBACK 오류가 callback 오류와 FAULT 오류를 가지는지
/// 확인한다.
#[cfg(feature = "test-faults")]
fn check_fault(driver: &str, error: &orm::Error, subject: &str) {
    let callback = check_rollback(driver, error, subject);
    assert_eq!(callback.to_string(), fault_callback().to_string(), "{driver}: {subject}: callback error");
    let orm::Error::Rollback { rollback, .. } = error else { unreachable!() };
    assert_eq!(rollback.code(), "FAULT", "{driver}: {subject}: rollback error {rollback}");
}

/// test entry point의 rollback fault다. commit된 transaction은 fault를 남기고,
/// callback이 실패한 다음 transaction은 rollback되며 그 rollback은 FAULT를
/// 보고하고 transaction은 callback 오류와 fault를 가진 ROLLBACK을 반환한다.
/// fault는 소비된다: 그 뒤 transaction은 callback 오류만 반환한다.
/// `transaction_send`와 `transaction_once`도 설정된 fault를 같은 방식으로
/// 소비하고, connection은 이후 요청을 처리한다.
#[cfg(feature = "test-faults")]
async fn rollback_fault(driver: &str, dsn: &str) {
    let db = installed(driver, dsn).await;
    orm::testing::fail_next_rollback(&db);
    db.transaction(async || create("committed").await).retry(0).await.unwrap_or_else(|e| panic!("{driver}: a committed transaction with an armed fault: {e}"));
    let failing = async || -> orm::Result<()> {
        create("rolled back").await?;
        Err(fault_callback())
    };
    let error = db.transaction(failing).retry(0).await.expect_err("transaction");
    check_fault(driver, &error, "transaction");
    let count = async || orm::model::get_count(connected(&db).core()).await.unwrap();
    assert_eq!(count().await, 1, "{driver}: the faulted rollback keeps only the committed row");
    let again = db.transaction(failing).retry(0).await.expect_err("transaction");
    assert!(
        matches!(again, orm::Error::Config(_)) && again.to_string() == fault_callback().to_string(),
        "{driver}: the transaction after the consumed fault = {again}"
    );
    assert_eq!(count().await, 1, "{driver}: the second rollback keeps only the committed row");

    orm::testing::fail_next_rollback(&db);
    let error = db
        .transaction_send(|| async {
            create("rolled back").await?;
            Err::<(), _>(fault_callback())
        })
        .retry(0)
        .await
        .expect_err("transaction_send");
    check_fault(driver, &error, "transaction_send");

    orm::testing::fail_next_rollback(&db);
    let error = db
        .transaction_once(async || -> Result<(), std::io::Error> {
            create("rolled back").await.map_err(std::io::Error::other)?;
            Err(std::io::Error::other("rollback fault callback failed"))
        })
        .await
        .expect_err("transaction_once");
    match error {
        orm::TransactionOnceError::Rollback { callback, rollback } => {
            assert_eq!(callback.to_string(), "rollback fault callback failed", "{driver}: transaction_once callback error");
            assert_eq!(rollback.code(), "FAULT", "{driver}: transaction_once rollback error {rollback}");
        }
        other => panic!("{driver}: transaction_once = {other}, want Rollback"),
    }
    assert_eq!(count().await, 1, "{driver}: the faulted rollbacks keep only the committed row");
    db.close().await;
}

/// case를 자기만의 case database에서 기한 안에 실행하고, 끝나면 database를 지운다.
async fn bounded(driver: &str, case: &str) {
    let database = CaseDatabase::create(driver).await;
    let dsn = database.dsn();
    let session = session_dsn(driver, &database);
    let run = async {
        match case {
            "rollback_failed" => rollback_failed(driver, dsn, &session).await,
            "savepoint_rollback_failed" => savepoint_rollback_failed(driver, dsn, &session).await,
            #[cfg(feature = "test-faults")]
            "rollback_fault" => rollback_fault(driver, dsn).await,
            other => unreachable!("unknown case {other}"),
        }
    };
    tokio::time::timeout(CASE_DEADLINE, run).await.unwrap_or_else(|_| panic!("{driver}: {case}: timeout after {CASE_DEADLINE:?}"));
    database.drop().await;
}

#[tokio::test]
async fn rollback_failed_sqlite() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("sqlite", "rollback_failed").await;
}

#[tokio::test]
async fn rollback_failed_mysql() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("mysql", "rollback_failed").await;
}

#[tokio::test]
async fn rollback_failed_postgres() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("postgres", "rollback_failed").await;
}

#[tokio::test]
async fn savepoint_rollback_failed_sqlite() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("sqlite", "savepoint_rollback_failed").await;
}

#[tokio::test]
async fn savepoint_rollback_failed_mysql() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("mysql", "savepoint_rollback_failed").await;
}

#[tokio::test]
async fn savepoint_rollback_failed_postgres() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("postgres", "savepoint_rollback_failed").await;
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn rollback_fault_sqlite() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("sqlite", "rollback_fault").await;
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn rollback_fault_mysql() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("mysql", "rollback_fault").await;
}

#[cfg(feature = "test-faults")]
#[tokio::test]
async fn rollback_fault_postgres() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("postgres", "rollback_fault").await;
}

/// test entry point는 feature `test-faults`가 있을 때만 있으며, crate의 어떤
/// default feature도 그것을 켜지 않는다.
#[test]
fn rollback_fault_entry() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    let manifest = std::fs::read_to_string(orm_testcase::manifest_dir().join("Cargo.toml")).unwrap();
    let features = manifest.split("[features]").nth(1).expect("the crate declares its features").split("\n[").next().unwrap();
    assert!(features.contains("test-faults = []"), "the crate declares the feature test-faults: {features}");
    let default = features.lines().find(|line| line.trim_start().starts_with("default"));
    assert!(default.is_none_or(|line| !line.contains("test-faults")), "a default feature enables test-faults: {default:?}");
}
