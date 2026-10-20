//! INT-52 `was_inserted` and INT-53 `backend_waiting_for_lock` on the utilities of the Rust client, on SQLite, MySQL and
//! PostgreSQL. The model is the clock fixture (contracts/fixtures/clock.dbs). Each case runs in a case database of its own
//! (polyspec-orm-case-database). The test fails when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.

use std::time::Duration;

use polyspec_orm::{Core, Db, Entity, Error, Model, Param, Schema, Val};
use polyspec_orm_case_database::CaseDatabase;

static CLOCK_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/clock.dbs"), "sha256:fab61fb83cfec00c4d7a4d257b610b87c6fdccd49e02a85848a41ba263bc1ffb");
static CLOCK_EVENT: Entity = Entity {
    name: "clock_event",
    schema: &CLOCK_SCHEMA,
    new: polyspec_orm::model::new_boxed::<ClockEvent>,
    collect: polyspec_orm::model::collect_boxed::<ClockEvent>,
};
const COLUMNS: [&str; 3] = ["seq", "label", "created_ts"];
const CASE_DEADLINE: Duration = Duration::from_secs(60);

#[derive(Clone)]
struct ClockEvent {
    core: Core,
    values: std::collections::BTreeMap<String, Val>,
}

impl Model for ClockEvent {
    fn entity() -> &'static Entity {
        &CLOCK_EVENT
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        ClockEvent { core, values: std::collections::BTreeMap::new() }
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

fn connected(db: &Db) -> ClockEvent {
    let mut core = Core::new(&CLOCK_EVENT);
    core.connect(db);
    ClockEvent::from_core(core)
}

/// Inserts one clock event with label in the active transaction and returns its identity key.
async fn insert_event(db: &Db, label: &str) -> i64 {
    let mut row = connected(db);
    row.core_mut().set("label", Param::from(label));
    let created = polyspec_orm::model::create(&mut row).await.unwrap_or_else(|e| panic!("create {label}: {e}"));
    match created.value("seq") {
        Some(Val::I64(seq)) => seq,
        other => panic!("the identity of {label}: {other:?}"),
    }
}

/// A generated insert inside a transaction is recorded for its key; a key never inserted is not; a nested rollback removes its key only.
async fn tracks_generated_rows(driver: &str, db: &Db) {
    let utils = db.utils();
    let result: polyspec_orm::Result<()> = db
        .transaction(async || {
            let outer = insert_event(db, "outer").await;
            assert!(utils.was_inserted("clock_event", outer).unwrap(), "{driver}: the outer insert is recorded");
            assert!(!utils.was_inserted("clock_event", outer + 1000).unwrap(), "{driver}: a key never inserted is not recorded");
            let nested = std::cell::Cell::new(0);
            let inner: polyspec_orm::Result<()> = db
                .transaction(async || {
                    let key = insert_event(db, "nested").await;
                    nested.set(key);
                    assert!(utils.was_inserted("clock_event", key).unwrap(), "{driver}: the nested insert is recorded");
                    Err(Error::Config("roll back the nested savepoint".into()))
                })
                .retry(0)
                .await;
            assert!(inner.is_err(), "{driver}: the nested transaction unexpectedly committed");
            assert!(!utils.was_inserted("clock_event", nested.get()).unwrap(), "{driver}: a rolled back insert leaves the write set");
            assert!(utils.was_inserted("clock_event", outer).unwrap(), "{driver}: the outer insert survives a nested rollback");
            Ok(())
        })
        .retry(0)
        .await;
    result.unwrap_or_else(|e| panic!("{driver}: {e}"));
}

/// The utility needs an active transaction and a valid entity and key; each violation is CONFIG.
async fn needs_a_transaction_and_valid_arguments(driver: &str, db: &Db) {
    let utils = db.utils();
    assert!(matches!(utils.was_inserted("clock_event", 1), Err(Error::Config(_))), "{driver}: outside a transaction");
    let result: polyspec_orm::Result<()> = db
        .transaction(async || {
            assert!(matches!(utils.was_inserted("", 1), Err(Error::Config(_))), "{driver}: an empty entity");
            assert!(matches!(utils.was_inserted("clock_event", 0), Err(Error::Config(_))), "{driver}: a zero key");
            assert!(matches!(utils.was_inserted("clock_event", -1), Err(Error::Config(_))), "{driver}: a negative key");
            Ok(())
        })
        .retry(0)
        .await;
    result.unwrap_or_else(|e| panic!("{driver}: {e}"));
}

/// SQLite and MySQL answer false without a statement; PostgreSQL with no waiter answers false.
async fn no_waiter(driver: &str, db: &Db) {
    assert!(!db.utils().backend_waiting_for_lock().await.unwrap_or_else(|e| panic!("{driver}: {e}")), "{driver}: no backend waits for a lock");
}

/// PostgreSQL: a second backend that waits for a row lock is reported. The transaction holds the row, and a task on a second
/// connection, started after the row is held, updates the same row and blocks until the transaction ends. The check is bounded
/// to ten seconds.
async fn postgres_waiter(dsn: &str, db: &Db) {
    let utils = db.utils();
    let seq = db
        .transaction(async || Ok(insert_event(db, "held").await))
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("postgres: {e}"));
    let (waiting, waiter) = db
        .transaction(async || {
            let mut row = connected(db);
            row.core_mut().set("seq", Param::from(seq));
            row.core_mut().set("label", Param::from("parent"));
            polyspec_orm::model::update(&mut row, false).await?;
            let owned = dsn.to_owned();
            let waiter = tokio::spawn(async move {
                let other = Db::connect_schema(&owned, &CLOCK_SCHEMA, 1, polyspec_orm::Config::default()).await?;
                let mut row = connected(&other);
                row.core_mut().set("seq", Param::from(seq));
                row.core_mut().set("label", Param::from("waiter"));
                let result = polyspec_orm::model::update(&mut row, false).await;
                other.close().await;
                result
            });
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let mut waiting = false;
            while !waiting && std::time::Instant::now() < deadline {
                waiting = utils.backend_waiting_for_lock().await?;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Ok((waiting, waiter))
        })
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("postgres: {e}"));
    assert!(waiting, "postgres: the waiting backend is reported while the transaction holds the row");
    waiter.await.expect("the waiter ends").unwrap_or_else(|e| panic!("postgres: the waiting update: {e}"));
}

async fn bounded(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let db = Db::connect_schema(database.dsn(), &CLOCK_SCHEMA, 4, polyspec_orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
    db.utils().schema().install(&CLOCK_SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    tracks_generated_rows(driver, &db).await;
    needs_a_transaction_and_valid_arguments(driver, &db).await;
    no_waiter(driver, &db).await;
    if driver == "postgres" {
        postgres_waiter(database.dsn(), &db).await;
    }
    db.close().await;
    database.drop().await;
}

#[tokio::test]
async fn was_inserted_sqlite() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(CASE_DEADLINE, bounded("sqlite")).await.expect("sqlite: the case ends");
}

#[tokio::test]
async fn was_inserted_mysql() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(CASE_DEADLINE, bounded("mysql")).await.expect("mysql: the case ends");
}

#[tokio::test]
async fn was_inserted_postgres() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    tokio::time::timeout(CASE_DEADLINE, bounded("postgres")).await.expect("postgres: the case ends");
}
