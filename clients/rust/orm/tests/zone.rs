//! Connection time zones: a wall-clock value is written and read back in the
//! connection zone, and the clock default of a created row is in the same
//! zone, on SQLite, MySQL and PostgreSQL. A test fails when
//! ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.

use chrono::{NaiveDate, NaiveDateTime, TimeZone, Utc};
use orm::core::{Arg, ChainKey};
use orm::db::Pool;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};

/// Returns the DSN in `var`; an unset or empty variable fails the test.
fn require_dsn(var: &str) -> String {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; database tests never skip"),
    }
}

static SCHEMA: Schema = Schema::new(include_bytes!("testdata/zone_schema.json"), "61829838dcc62cf6");

/// Both tests create and drop zone_event in the same database, so they run
/// one at a time.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

static ENTITY: Entity =
    Entity { name: "zone_event", schema: &SCHEMA, new: orm::model::new_boxed::<ZoneEvent>, collect: orm::model::collect_boxed::<ZoneEvent> };

#[derive(Clone)]
struct ZoneEvent {
    core: Core,
    seq: i64,
    start_dt: NaiveDateTime,
    created_ts: NaiveDateTime,
}

impl Model for ZoneEvent {
    fn entity() -> &'static Entity {
        &ENTITY
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        ZoneEvent { core, seq: 0, start_dt: NaiveDateTime::default(), created_ts: NaiveDateTime::default() }
    }
    fn into_core(self) -> Core {
        self.core
    }
    fn assign(&mut self, name: &str, v: Val) -> bool {
        match name {
            "seq" => self.seq = v.as_i64(),
            "start_dt" => self.start_dt = v.as_datetime(),
            "created_ts" => self.created_ts = v.as_datetime(),
            _ => return false,
        }
        true
    }
    fn value(&self, name: &str) -> Option<Val> {
        Some(match name {
            "seq" => Val::I64(self.seq),
            "start_dt" => Val::DateTime(self.start_dt),
            "created_ts" => Val::DateTime(self.created_ts),
            _ => return None,
        })
    }
}

fn event(db: &Db) -> ZoneEvent {
    let mut core = Core::new(&ENTITY);
    core.connect(db);
    ZoneEvent::from_core(core)
}

/// The current wall-clock time in a zone of the test.
fn wall_clock(zone: &str) -> NaiveDateTime {
    let now = Utc::now();
    match zone {
        "Asia/Seoul" => chrono_tz::Asia::Seoul.from_utc_datetime(&now.naive_utc()).naive_local(),
        _ => {
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            let secs = sign * (zone[1..3].parse::<i32>().unwrap() * 3600 + zone[4..6].parse::<i32>().unwrap() * 60);
            now.with_timezone(&chrono::FixedOffset::east_opt(secs).unwrap()).naive_local()
        }
    }
}

async fn drop_table(db: &Db) {
    let statement = sqlx::raw_sql("DROP TABLE IF EXISTS zone_event");
    match db.pool() {
        Pool::MySql(p) => statement.execute(p).await.map(|_| ()),
        Pool::Postgres(p) => statement.execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => statement.execute(p).await.map(|_| ()),
    }
    .unwrap();
}

#[tokio::test]
async fn connection_time_zone() {
    let _serial = SERIAL.lock().await;
    let tmp = std::env::temp_dir().join(format!("orm-rust-zone-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let mysql_dsn = require_dsn("ORM_TEST_MYSQL_DSN");
    let postgres_dsn = require_dsn("ORM_TEST_POSTGRES_DSN");
    let targets = vec![("sqlite".to_owned(), String::new()), ("mysql".to_owned(), mysql_dsn), ("postgres".to_owned(), postgres_dsn)];
    let start = NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(0, 0, 0).unwrap();
    for (driver, base) in &targets {
        for zone in ["+00:00", "+09:00", "-05:30", "Asia/Seoul"] {
            let base = if driver == "sqlite" {
                format!("sqlite://{}", tmp.join(format!("zone{}.sqlite", zone.replace([':', '/', '+'], "_"))).display())
            } else {
                base.clone()
            };
            let sep = if base.contains('?') { '&' } else { '?' };
            let dsn = format!("{base}{sep}timezone={}", zone.replace('+', "%2B"));
            let label = format!("{driver}/{zone}");
            let db = Db::connect(&dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{label}: {e}"));
            drop_table(&db).await;
            db.utils().schema().install(SCHEMA.json()).await.unwrap_or_else(|e| panic!("{label}: install: {e}"));
            let before = wall_clock(zone);
            let mut row = event(&db);
            row.core_mut().set("start_dt", Param::DateTime(start));
            orm::model::create(&mut row).await.unwrap_or_else(|e| panic!("{label}: create: {e}"));
            let got = orm::model::get(&event(&db)).await.unwrap_or_else(|e| panic!("{label}: {e}"));
            assert_eq!(got.start_dt, start, "{label}: start_dt");
            let skew = (got.created_ts - before).num_seconds().abs();
            assert!(skew < 60, "{label}: created_ts {} is not about {before}", got.created_ts);
            const KEYS: &[ChainKey] = &[ChainKey { conn: "", op: "", column: "start_dt", columns: &[], compare: "" }];
            let filter = event(&db).core().by(KEYS, vec![Arg::Value(orm::args::Value::One(Param::DateTime(start)))]);
            let found = orm::model::get_count(&filter).await.unwrap_or_else(|e| panic!("{label}: count: {e}"));
            assert_eq!(found, 1, "{label}: where start_dt");
            let text = |v: &str| Param::Str(v.to_owned());
            const BETWEEN: &[ChainKey] = &[ChainKey { conn: "", op: "between", column: "start_dt", columns: &[], compare: "" }];
            let filters = [
                ("equal by text", KEYS, orm::args::Value::One(text("2026-01-02 00:00:00")), 1),
                ("equal by text with fraction", KEYS, orm::args::Value::One(text("2026-01-02T00:00:00.0")), 1),
                ("in by text", KEYS, orm::args::Value::List(vec![text("2026-01-02 00:00:00"), text("2026-01-03 00:00:00")]), 1),
                ("between by text", BETWEEN, orm::args::Value::Pair(text("2026-01-02 00:00:00"), text("2026-01-02 00:00:00.5")), 1),
            ];
            for (name, keys, value, want) in filters {
                let filter = event(&db).core().by(keys, vec![Arg::Value(value)]);
                let found = orm::model::get_count(&filter).await.unwrap_or_else(|e| panic!("{label}: {name}: {e}"));
                assert_eq!(found, want, "{label}: {name}");
            }
            if driver == "sqlite" {
                let filter = event(&db).core().by(KEYS, vec![Arg::Value(orm::args::Value::One(text("2026-01-02")))]);
                let err = orm::model::get_count(&filter).await.expect_err("date-only datetime text");
                assert_eq!(err.code(), orm::codes::CODEC_ENCODE, "{label}: date-only datetime text: {err}");
            }
            drop_table(&db).await;
            db.close().await;
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
}

/// A MySQL install inside a transaction returns CONFIG: schema statements
/// commit implicitly.
#[tokio::test]
async fn mysql_install_inside_transaction() {
    let _serial = SERIAL.lock().await;
    let dsn = require_dsn("ORM_TEST_MYSQL_DSN");
    let db = Db::connect(&dsn, 2, orm::Config::default()).await.unwrap();
    drop_table(&db).await;
    let inside: orm::Result<()> = db.transaction(async || db.utils().schema().install(SCHEMA.json()).await).await;
    assert_eq!(inside.as_ref().map_err(|e| e.code().to_owned()), Err(orm::codes::CONFIG.to_owned()), "install inside a transaction: {inside:?}");
    db.utils().schema().install(SCHEMA.json()).await.unwrap();
    drop_table(&db).await;
    db.close().await;
}

/// The pool size a connection is opened with is its maximum open connections.
#[tokio::test]
async fn pool_size() {
    let tmp = std::env::temp_dir().join(format!("orm-rust-pool-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let dsn = format!("sqlite://{}", tmp.join("pool.sqlite").display());
    let db = Db::connect(&dsn, 3, orm::Config::default()).await.unwrap();
    assert_eq!(db.stats().max_open_connections, 3, "configured pool size");
    db.close().await;
    let _ = std::fs::remove_dir_all(&tmp);
}

/// `pool_idle_size` bounds the idle connections a pool keeps, and
/// `pool_lifetime_ms` closes a connection after its lifetime; an idle size
/// above the pool size returns CONFIG.
#[tokio::test]
async fn pool_idle_size_and_lifetime() {
    let tmp = std::env::temp_dir().join(format!("orm-rust-pool-idle-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let dsn = format!("sqlite://{}", tmp.join("pool.sqlite").display());
    for (size, idle) in [(3, 4), (0, 11)] {
        let r = Db::connect(&dsn, size, orm::Config { pool_idle_size: idle, ..orm::Config::default() }).await;
        assert_eq!(r.err().map(|e| e.code().to_owned()), Some(orm::codes::CONFIG.to_owned()), "pool size {size}, idle size {idle}");
    }
    let Pool::Sqlite(unset) = Db::connect(&dsn, 3, orm::Config::default()).await.unwrap().pool().clone() else { unreachable!() };
    assert_eq!(unset.options().get_max_lifetime(), Some(std::time::Duration::from_secs(30 * 60)), "default lifetime");
    unset.close().await;

    // Three connections are in use at once; after they return the pool keeps
    // one idle connection and closes the others.
    let db = Db::connect(&dsn, 3, orm::Config { pool_idle_size: 1, ..orm::Config::default() }).await.unwrap();
    let Pool::Sqlite(pool) = db.pool().clone() else { unreachable!() };
    let mut held = Vec::new();
    for _ in 0..3 {
        held.push(pool.acquire().await.unwrap());
    }
    assert_eq!(db.stats().open_connections, 3, "three connections in use");
    for mut conn in held {
        conn.return_to_pool().await;
    }
    assert_eq!((db.stats().idle, db.stats().open_connections), (1, 1), "pool idle size 1");
    db.close().await;

    let db = Db::connect(&dsn, 2, orm::Config { pool_lifetime_ms: 100, ..orm::Config::default() }).await.unwrap();
    let Pool::Sqlite(pool) = db.pool().clone() else { unreachable!() };
    assert_eq!(pool.options().get_max_lifetime(), Some(std::time::Duration::from_millis(100)), "configured lifetime");
    assert_eq!(db.stats().open_connections, 1, "the connection opened by connect");
    // The pool checks the lifetime of its idle connections every 100 ms.
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert_eq!(db.stats().open_connections, 0, "pool lifetime 100 ms keeps a connection open after 400 ms");
    db.close().await;
    let _ = std::fs::remove_dir_all(&tmp);
}

/// A pool size of zero opens a pool of 10 connections, and a pool never runs
/// more concurrent transactions or opens more connections than its maximum.
#[tokio::test]
async fn pool_size_bound() {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    for (driver, var) in [("mysql", "ORM_TEST_MYSQL_DSN"), ("postgres", "ORM_TEST_POSTGRES_DSN")] {
        let dsn = require_dsn(var);
        let unset = tokio::time::timeout(std::time::Duration::from_secs(5), Db::connect(&dsn, 0, orm::Config::default()))
            .await
            .unwrap_or_else(|_| panic!("{driver}: a pool size of zero did not connect"))
            .unwrap_or_else(|e| panic!("{driver}: {e}"));
        assert_eq!(unset.stats().max_open_connections, 10, "{driver}: pool size zero");
        unset.close().await;
        // Each transaction holds a connection while it runs, so six
        // transactions on a pool of two run at most two at a time.
        let bounded = Db::connect(&dsn, 2, orm::Config::default()).await.unwrap();
        let (active, peak, opened) = (Arc::new(AtomicU32::new(0)), Arc::new(AtomicU32::new(0)), Arc::new(AtomicU32::new(0)));
        // A transaction future is not Send, so the tasks run on a LocalSet.
        let local = tokio::task::LocalSet::new();
        let mut tasks = Vec::new();
        for _ in 0..6 {
            let (db, active, peak, opened) = (bounded.clone(), active.clone(), peak.clone(), opened.clone());
            tasks.push(local.spawn_local(async move {
                let r: orm::Result<()> = db
                    .transaction(async || {
                        let n = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(n, Ordering::SeqCst);
                        opened.fetch_max(db.stats().open_connections, Ordering::SeqCst);
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .await;
                r.unwrap();
            }));
        }
        local
            .run_until(async {
                for task in tasks {
                    task.await.unwrap();
                }
            })
            .await;
        let (peak, opened) = (peak.load(Ordering::SeqCst), opened.load(Ordering::SeqCst));
        assert!(peak == 2 && opened <= 2, "{driver}: pool of 2: {peak} concurrent transactions, {opened} open connections");
        bounded.close().await;
    }
}

/// A slow condition of the test, per dialect. MySQL bounds SELECT statements
/// with max_execution_time, PostgreSQL bounds every statement, and SQLite has
/// no session timeout.
fn slow(driver: &str) -> Option<&'static str> {
    match driver {
        "mysql" => Some("SLEEP(5) = 0"),
        "postgres" => Some("pg_sleep(5) IS NULL"),
        _ => None,
    }
}

fn slow_count(db: &Db, condition: &str) -> Core {
    let mut core = Core::new(&ENTITY);
    core.connect(db);
    core.raw("", condition, Vec::new());
    core
}

/// A statement past the connection timeout returns CANCELED.
#[tokio::test]
async fn statement_timeout() {
    let _serial = SERIAL.lock().await;
    for (driver, var) in [("mysql", "ORM_TEST_MYSQL_DSN"), ("postgres", "ORM_TEST_POSTGRES_DSN")] {
        let dsn = require_dsn(var);
        let cfg = orm::Config { statement_timeout_ms: 200, ..orm::Config::default() };
        let db = Db::connect(&dsn, 2, cfg).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
        drop_table(&db).await;
        db.utils().schema().install(SCHEMA.json()).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
        // The condition is evaluated per row, so the table holds one row.
        let mut row = event(&db);
        row.core_mut().set("start_dt", Param::DateTime(NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(0, 0, 0).unwrap()));
        orm::model::create(&mut row).await.unwrap_or_else(|e| panic!("{driver}: create: {e}"));
        let err = orm::model::get_count(&slow_count(&db, slow(driver).unwrap())).await.expect_err("a statement past the timeout");
        assert_eq!(err.code(), orm::codes::CANCELED, "{driver}: {err}");
        drop_table(&db).await;
        db.close().await;
    }
}

/// A pooler in transaction mode hands one server session to every client in
/// turn. Through ORM_TEST_PGBOUNCER_SINGLE_DSN every client shares one server
/// connection, so the statement timeout of one connection bounds only the
/// statements of that connection.
#[tokio::test]
async fn statement_timeout_through_a_pooler() {
    let _serial = SERIAL.lock().await;
    let setup = Db::connect(&require_dsn("ORM_TEST_POSTGRES_DSN"), 1, orm::Config::default()).await.unwrap();
    drop_table(&setup).await;
    setup.utils().schema().install(SCHEMA.json()).await.unwrap();
    // Three rows sleep 0.1 s each, so the statement runs past 200 ms.
    for _ in 0..3 {
        let mut row = event(&setup);
        row.core_mut().set("start_dt", Param::DateTime(NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(0, 0, 0).unwrap()));
        orm::model::create(&mut row).await.unwrap();
    }
    let single = require_dsn("ORM_TEST_PGBOUNCER_SINGLE_DSN");
    let slow = "pg_sleep(0.1) IS NOT NULL";
    let bounded = Db::connect(&single, 1, orm::Config { statement_timeout_ms: 200, ..orm::Config::default() }).await.unwrap();
    let err = orm::model::get_count(&slow_count(&bounded, slow)).await.expect_err("the bounded connection through the pooler");
    assert_eq!(err.code(), orm::codes::CANCELED, "the bounded connection through the pooler: {err}");
    let plain = Db::connect(&single, 1, orm::Config::default()).await.unwrap();
    let count = orm::model::get_count(&slow_count(&plain, slow)).await;
    assert_eq!(count.map_err(|e| e.to_string()), Ok(3), "a connection without a timeout after the bounded one");
    let err = orm::model::get_count(&slow_count(&bounded, slow)).await.expect_err("the bounded connection after the plain one");
    assert_eq!(err.code(), orm::codes::CANCELED, "the bounded connection after the plain one: {err}");
    bounded.close().await;
    plain.close().await;
    drop_table(&setup).await;
    setup.close().await;
}

/// A PostgreSQL connection reads float8 values exactly in the text format
/// of the simple protocol and in the binary format of prepared statements.
#[tokio::test]
async fn postgres_float_round_trip() {
    let db = Db::connect(&require_dsn("ORM_TEST_POSTGRES_DSN"), 1, orm::Config::default()).await.unwrap();
    let Pool::Postgres(pool) = db.pool() else { panic!("a postgres pool") };
    let values = [0.1 + 0.2, 1.0 / 3.0, f64::MIN_POSITIVE, 5e-324, f64::MAX, -123456.789e-7];
    for v in values {
        let literal = format!("SELECT {v:e}::float8");
        let text: f64 = sqlx::Row::get(&sqlx::raw_sql(sqlx::AssertSqlSafe(literal.clone())).fetch_one(pool).await.unwrap(), 0);
        assert_eq!(text.to_bits(), v.to_bits(), "text format of {v:e}: {text:e}");
        let binary: f64 = sqlx::query_scalar("SELECT $1::float8").bind(v).fetch_one(pool).await.unwrap();
        assert_eq!(binary.to_bits(), v.to_bits(), "binary format of {v:e}: {binary:e}");
    }
    db.close().await;
}

/// Dropping the future of a statement cancels the statement, and the
/// connection it ran on stays usable.
#[tokio::test]
async fn dropping_a_query_cancels_it() {
    let _serial = SERIAL.lock().await;
    for (driver, var) in [("mysql", "ORM_TEST_MYSQL_DSN"), ("postgres", "ORM_TEST_POSTGRES_DSN")] {
        let dsn = require_dsn(var);
        let db = Db::connect(&dsn, 1, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
        drop_table(&db).await;
        db.utils().schema().install(SCHEMA.json()).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
        let mut row = event(&db);
        row.core_mut().set("start_dt", Param::DateTime(NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(0, 0, 0).unwrap()));
        orm::model::create(&mut row).await.unwrap_or_else(|e| panic!("{driver}: create: {e}"));

        let slow = slow_count(&db, slow(driver).unwrap());
        let started = std::time::Instant::now();
        let dropped = tokio::time::timeout(std::time::Duration::from_millis(300), orm::model::get_count(&slow)).await;
        assert!(dropped.is_err(), "{driver}: the slow statement finished");
        assert!(started.elapsed() < std::time::Duration::from_secs(4), "{driver}: dropping waited for the statement");
        // The pool holds one connection, so the next statement proves the
        // cancelled one released it.
        let count = tokio::time::timeout(std::time::Duration::from_secs(5), orm::model::get_count(event(&db).core()))
            .await
            .unwrap_or_else(|_| panic!("{driver}: the connection did not come back"))
            .unwrap_or_else(|e| panic!("{driver}: count after cancellation: {e}"));
        assert_eq!(count, 1, "{driver}: rows after cancellation");
        drop_table(&db).await;
        db.close().await;
    }
}
