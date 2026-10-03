//! The clock of `default now`, soft deletion and the now conditions, on SQLite,
//! MySQL and PostgreSQL (contracts/fixtures/clock.dbs, clock_mark.dbs).
//! Each insert of clock_event fills created_ts from the clock, so its stored
//! fraction holds the microseconds of the wall clock. A clock with
//! millisecond resolution stores every value as `.mmm000`. The test fails
//! when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.

use std::time::Duration;

use orm::core::{Arg, ChainKey};
use orm::db::Pool;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};

static CLOCK_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/clock.dbs"), "sha256:fab61fb83cfec00c4d7a4d257b610b87c6fdccd49e02a85848a41ba263bc1ffb");
static CLOCK_EVENT: Entity =
    Entity { name: "clock_event", schema: &CLOCK_SCHEMA, new: orm::model::new_boxed::<ClockEvent>, collect: orm::model::collect_boxed::<ClockEvent> };
const COLUMNS: [&str; 3] = ["seq", "label", "created_ts"];
const CASE_DEADLINE: Duration = Duration::from_secs(30);

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

fn connected(db: &Db) -> ClockEvent {
    let mut core = Core::new(&CLOCK_EVENT);
    core.connect(db);
    ClockEvent::from_core(core)
}

/// Returns the DSN of a target; an unset or empty variable fails the test.
fn target(driver: &str, file: &str) -> String {
    if driver == "sqlite" {
        let dir = std::env::temp_dir().join(format!("orm-rust-clock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(file);
        let _ = std::fs::remove_file(&path);
        return format!("sqlite://{}", path.display());
    }
    let var = format!("ORM_TEST_{}_DSN", driver.to_uppercase());
    match std::env::var(&var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; database tests never skip"),
    }
}

async fn drop_table(db: &Db) {
    let result = match db.pool() {
        Pool::MySql(p) => sqlx::raw_sql("DROP TABLE IF EXISTS `clock_event`").execute(p).await.map(|_| ()),
        Pool::Postgres(p) => sqlx::raw_sql(r#"DROP TABLE IF EXISTS "clock_event""#).execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => sqlx::raw_sql(r#"DROP TABLE IF EXISTS "clock_event""#).execute(p).await.map(|_| ()),
    };
    result.unwrap_or_else(|e| panic!("drop clock_event: {e}"));
}

/// Sixteen inserts in separate statements store created_ts with six fraction
/// digits near the wall clock; at least one value has microseconds that a
/// millisecond clock cannot give.
async fn clock_microseconds(driver: &str) {
    // 모든 connection은 UTC다.
    let dsn = target(driver, "clock.sqlite");
    let db = Db::connect(&dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
    drop_table(&db).await;
    db.utils().schema().install(&CLOCK_SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    let before = chrono::Utc::now().naive_utc();
    for i in 0..16 {
        let mut row = connected(&db);
        row.core_mut().set("label", Param::from(format!("event-{i}").as_str()));
        orm::model::create(&mut row).await.unwrap_or_else(|e| panic!("{driver}: create: {e}"));
    }
    let after = chrono::Utc::now().naive_utc();
    let mut q = connected(&db);
    q.core_mut().add_all_columns();
    q.core_mut().order_by("seq", false, None);
    let rows = orm::model::gets(&q).await.unwrap_or_else(|e| panic!("{driver}: gets: {e}")).into_vec();
    assert_eq!(rows.len(), 16, "{driver}: rows");
    let mut sub = false;
    for row in &rows {
        // SQLite stores the text form; MySQL and PostgreSQL return a date-time.
        let created = match row.values.get("created_ts") {
            Some(Val::DateTime(t)) => *t,
            Some(Val::Str(text)) => {
                let fraction = text.rsplit_once('.').map(|(_, f)| f).unwrap_or("");
                assert!(fraction.len() == 6 && fraction.bytes().all(|b| b.is_ascii_digit()), "{driver}: created_ts {text} has six fraction digits");
                chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f").unwrap_or_else(|e| panic!("{driver}: created_ts {text}: {e}"))
            }
            other => panic!("{driver}: created_ts {other:?}"),
        };
        let created = &created;
        let nanos = chrono::Timelike::nanosecond(created);
        assert_eq!(nanos % 1000, 0, "{driver}: created_ts {created} has more than six fraction digits");
        assert!(*created >= before - chrono::Duration::microseconds(1) && *created <= after, "{driver}: created_ts {created} outside {before} and {after}");
        sub |= nanos % 1_000_000 != 0;
    }
    assert!(sub, "{driver}: every created_ts ends in 000");
    drop_table(&db).await;
    db.close().await;
}

async fn bounded(driver: &str) {
    tokio::time::timeout(CASE_DEADLINE, clock_microseconds(driver)).await.unwrap_or_else(|_| panic!("{driver}: timeout after {CASE_DEADLINE:?}"));
}

#[tokio::test]
async fn clock_microseconds_sqlite() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("sqlite").await;
}

#[tokio::test]
async fn clock_microseconds_mysql() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("mysql").await;
}

#[tokio::test]
async fn clock_microseconds_postgres() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("postgres").await;
}

static CLOCK_MARK_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/clock_mark.dbs"), "sha256:f695f5f387baf1a92682394f9ca814958e0837e1ec4c429ca2d19feb58767683");
static CLOCK_MARK: Entity =
    Entity { name: "clock_mark", schema: &CLOCK_MARK_SCHEMA, new: orm::model::new_boxed::<ClockMark>, collect: orm::model::collect_boxed::<ClockMark> };
const MARK_COLUMNS: [&str; 4] = ["seq", "label", "created_ts", "deleted_at"];

#[derive(Clone)]
struct ClockMark {
    core: Core,
    values: std::collections::BTreeMap<String, Val>,
}

impl Model for ClockMark {
    fn entity() -> &'static Entity {
        &CLOCK_MARK
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        ClockMark { core, values: std::collections::BTreeMap::new() }
    }
    fn into_core(self) -> Core {
        self.core
    }
    fn assign(&mut self, name: &str, v: Val) -> orm::Result<bool> {
        if !MARK_COLUMNS.contains(&name) {
            return Ok(false);
        }
        self.values.insert(name.to_owned(), v);
        Ok(true)
    }
    fn value(&self, name: &str) -> Option<Val> {
        self.values.get(name).cloned()
    }
}

fn mark(db: &Db) -> ClockMark {
    let mut core = Core::new(&CLOCK_MARK);
    core.connect(db);
    ClockMark::from_core(core)
}

async fn drop_mark(db: &Db) {
    let result = match db.pool() {
        Pool::MySql(p) => sqlx::raw_sql("DROP TABLE IF EXISTS `clock_mark`").execute(p).await.map(|_| ()),
        Pool::Postgres(p) => sqlx::raw_sql(r#"DROP TABLE IF EXISTS "clock_mark""#).execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => sqlx::raw_sql(r#"DROP TABLE IF EXISTS "clock_mark""#).execute(p).await.map(|_| ()),
    };
    result.unwrap_or_else(|e| panic!("drop clock_mark: {e}"));
}

/// Connects (every connection is UTC) and installs the clock_mark document on
/// a dropped table.
async fn mark_db(driver: &str, file: &str) -> Db {
    let dsn = target(driver, file);
    let db = Db::connect(&dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
    drop_mark(&db).await;
    db.utils().schema().install(&CLOCK_MARK_SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    db
}

async fn create_mark(db: &Db, driver: &str, i: usize) -> ClockMark {
    let mut row = mark(db);
    row.core_mut().set("label", Param::from(format!("mark-{i}").as_str()));
    orm::model::create(&mut row).await.unwrap_or_else(|e| panic!("{driver}: create: {e}"))
}

/// Sixteen soft deletions in separate statements store deleted_at with six
/// fraction digits. Model reads exclude soft-deleted rows, so the case reads
/// deleted_at with the connection pool. At least one value has microseconds
/// that a whole-second clock cannot give.
async fn clock_soft_delete_microseconds(driver: &str) {
    let db = mark_db(driver, "clock_soft_delete.sqlite").await;
    for i in 0..16 {
        let row = create_mark(&db, driver, i).await;
        orm::model::delete(&row, false).await.unwrap_or_else(|e| panic!("{driver}: delete: {e}"));
    }
    let stamps: Vec<Option<String>> = match db.pool() {
        Pool::MySql(p) => sqlx::query_scalar("SELECT DATE_FORMAT(deleted_at, '%Y-%m-%d %H:%i:%s.%f') FROM clock_mark ORDER BY seq").fetch_all(p).await,
        Pool::Postgres(p) => sqlx::query_scalar("SELECT to_char(deleted_at, 'YYYY-MM-DD HH24:MI:SS.US') FROM clock_mark ORDER BY seq").fetch_all(p).await,
        Pool::Sqlite(p) => sqlx::query_scalar("SELECT deleted_at FROM clock_mark ORDER BY seq").fetch_all(p).await,
    }
    .unwrap_or_else(|e| panic!("{driver}: read deleted_at: {e}"));
    assert_eq!(stamps.len(), 16, "{driver}: rows");
    let mut sub = false;
    for stamp in &stamps {
        let stamp = stamp.as_deref().unwrap_or_else(|| panic!("{driver}: deleted_at is NULL after a soft deletion"));
        chrono::NaiveDateTime::parse_from_str(stamp, "%Y-%m-%d %H:%M:%S%.6f").unwrap_or_else(|e| panic!("{driver}: deleted_at {stamp}: {e}"));
        let fraction = stamp.rsplit_once('.').map(|(_, f)| f).unwrap_or("");
        assert_eq!(fraction.len(), 6, "{driver}: deleted_at {stamp} has six fraction digits");
        sub |= !stamp.ends_with("000");
    }
    assert!(sub, "{driver}: every deleted_at ends in 000: {stamps:?}");
    drop_mark(&db).await;
    db.close().await;
}

/// Sixteen rows are read back right after their insert with created_ts <=
/// now() and created_ts <= seconds_later(0). The database clock of the
/// condition is later than the stored creation time, so both match the row.
async fn clock_now_condition(driver: &str) {
    const KEYS: &[ChainKey] = &[
        ChainKey { conn: "", op: "", column: "seq", columns: &[], compare: "" },
        ChainKey { conn: "and", op: "le", column: "created_ts", columns: &[], compare: "" },
    ];
    let db = mark_db(driver, "clock_now_condition.sqlite").await;
    for i in 0..16 {
        let row = create_mark(&db, driver, i).await;
        let seq = match row.values.get("seq") {
            Some(Val::I64(seq)) => *seq,
            other => panic!("{driver}: seq {other:?}"),
        };
        for (name, func) in [("now", orm::args::now()), ("seconds_later(0)", orm::args::seconds_later(0))] {
            let filter = mark(&db).core().by(KEYS, vec![Arg::Value(orm::args::Value::One(Param::I64(seq))), Arg::Value(orm::args::Value::Func(func))]);
            let found = orm::model::get_count(&filter).await.unwrap_or_else(|e| panic!("{driver}: count: {e}"));
            assert_eq!(found, 1, "{driver}: row {seq} with created_ts <= {name}");
        }
    }
    drop_mark(&db).await;
    db.close().await;
}

/// Serializes the clock_mark cases, which share the clock_mark table of the
/// MySQL and PostgreSQL test databases.
static MARK_TABLE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn bounded_mark(driver: &str, case: &str) {
    let _table = MARK_TABLE.lock().await;
    let run = async {
        match case {
            "soft_delete" => clock_soft_delete_microseconds(driver).await,
            _ => clock_now_condition(driver).await,
        }
    };
    tokio::time::timeout(CASE_DEADLINE, run).await.unwrap_or_else(|_| panic!("{driver}: {case}: timeout after {CASE_DEADLINE:?}"));
}

#[tokio::test]
async fn clock_soft_delete_microseconds_sqlite() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded_mark("sqlite", "soft_delete").await;
}

#[tokio::test]
async fn clock_soft_delete_microseconds_mysql() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded_mark("mysql", "soft_delete").await;
}

#[tokio::test]
async fn clock_soft_delete_microseconds_postgres() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded_mark("postgres", "soft_delete").await;
}

#[tokio::test]
async fn clock_now_condition_sqlite() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded_mark("sqlite", "now_condition").await;
}

#[tokio::test]
async fn clock_now_condition_mysql() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded_mark("mysql", "now_condition").await;
}

#[tokio::test]
async fn clock_now_condition_postgres() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded_mark("postgres", "now_condition").await;
}
