//! The client clock of the `now` bind slot, on SQLite, MySQL and PostgreSQL.
//! Each insert of clock_event fills created_ts from the clock, so its stored
//! fraction holds the microseconds of the wall clock. A clock with
//! millisecond resolution stores every value as `.mmm000`. The test fails
//! when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.

use std::time::Duration;

use orm::db::Pool;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};

static CLOCK_SCHEMA: Schema = Schema::new(include_bytes!("../../../../contracts/fixtures/clock_schema.json"), "163bb7d816065e82");
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
fn target(driver: &str) -> String {
    if driver == "sqlite" {
        let dir = std::env::temp_dir().join(format!("orm-rust-clock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clock.sqlite");
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
    let base = target(driver);
    let dsn = format!("{base}{}timezone=%2B00:00", if base.contains('?') { '&' } else { '?' });
    let db = Db::connect(&dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
    drop_table(&db).await;
    db.utils().schema().install(CLOCK_SCHEMA.json()).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
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
    bounded("sqlite").await;
}

#[tokio::test]
async fn clock_microseconds_mysql() {
    bounded("mysql").await;
}

#[tokio::test]
async fn clock_microseconds_postgres() {
    bounded("postgres").await;
}
