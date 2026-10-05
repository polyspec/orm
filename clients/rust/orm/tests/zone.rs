//! Connection time zones: every connection reads and writes datetime values in
//! UTC on SQLite, MySQL and PostgreSQL, whatever the server zone (docs/dialects.md
//! "Date and time"); a wall-clock value round-trips and `default now` writes the
//! UTC statement time. A test that installs zone_event does so in a case
//! database of its own (orm-case-database). A test fails when
//! ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.

use chrono::{NaiveDate, NaiveDateTime, Utc};
use orm::core::{Arg, ChainKey};
use orm::db::Pool;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};
use orm_case_database::{CaseDatabase, CaseTable};

/// Returns the DSN in `var`; an unset or empty variable fails the test.
fn require_dsn(var: &str) -> String {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; database tests never skip"),
    }
}

static SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/zone.dbs"), "sha256:c889e6d039d9245e5093d386a7c707419fddf5f9a303d39a5eb7cca4c8499891");

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
    fn assign(&mut self, name: &str, v: Val) -> orm::Result<bool> {
        match name {
            "seq" => self.seq = v.as_i64()?,
            "start_dt" => self.start_dt = v.as_datetime()?,
            "created_ts" => self.created_ts = v.as_datetime()?,
            _ => return Ok(false),
        }
        Ok(true)
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

#[tokio::test]
async fn connections_use_utc() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    let start = NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(0, 0, 0).unwrap();
    for driver in ["sqlite", "mysql", "postgres"] {
        // 시험 server의 MySQL은 SYSTEM(KST), PostgreSQL은 Asia/Seoul이다.
        for zone in ["", "UTC", "+00:00"] {
            // zone마다 schema를 새로 설치하므로 자기 case database를 쓴다.
            let database = CaseDatabase::create(driver).await;
            let base = database.dsn().to_owned();
            let sep = if base.contains('?') { '&' } else { '?' };
            let dsn = if zone.is_empty() { base.clone() } else { format!("{base}{sep}timezone={}", zone.replace('+', "%2B")) };
            let label = format!("{driver}/{zone}");
            let db = Db::connect(&dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{label}: {e}"));
            db.utils().schema().install(&SCHEMA).await.unwrap_or_else(|e| panic!("{label}: install: {e}"));
            let before = Utc::now().naive_utc();
            let mut row = event(&db);
            row.core_mut().set("start_dt", Param::DateTime(start));
            orm::model::create(&mut row).await.unwrap_or_else(|e| panic!("{label}: create: {e}"));
            let got = orm::model::get(&event(&db)).await.unwrap_or_else(|e| panic!("{label}: {e}"));
            assert_eq!(got.start_dt, start, "{label}: start_dt");
            // `default now`는 UTC statement 시각이다.
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
            db.close().await;
            database.drop().await;
        }
    }
}

/// UTC가 아닌 timezone parameter는 CONFIG로 실패한다.
#[test]
fn non_utc_time_zones_are_rejected() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    for dsn in [
        "mysql://root@localhost/orm_example?timezone=%2B09:00",
        "postgres://root@localhost/orm_example?timezone=Asia/Seoul",
        "sqlite:///tmp/orm_example.sqlite?timezone=Asia%2FSeoul",
    ] {
        let err = orm::db::parse_dsn(dsn).err().unwrap_or_else(|| panic!("{dsn}: a non-UTC timezone was accepted"));
        assert_eq!(err.code(), orm::codes::CONFIG, "{dsn}: {err}");
    }
    for dsn in
        ["mysql://root@localhost/orm_example", "postgres://root@localhost/orm_example?timezone=UTC", "sqlite:///tmp/orm_example.sqlite?timezone=%2B00:00"]
    {
        orm::db::parse_dsn(dsn).unwrap_or_else(|e| panic!("{dsn}: {e}"));
    }
}

/// A MySQL install inside a transaction returns CONFIG: schema statements
/// commit implicitly.
#[tokio::test]
async fn mysql_install_inside_transaction() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    let database = CaseDatabase::create("mysql").await;
    let db = Db::connect(database.dsn(), 2, orm::Config::default()).await.unwrap();
    let inside: orm::Result<()> = db.transaction(async || db.utils().schema().install(&SCHEMA).await).await;
    assert_eq!(inside.as_ref().map_err(|e| e.code().to_owned()), Err(orm::codes::CONFIG.to_owned()), "install inside a transaction: {inside:?}");
    db.utils().schema().install(&SCHEMA).await.unwrap();
    db.close().await;
    database.drop().await;
}

/// The pool size a connection is opened with is its maximum open connections.
#[tokio::test]
async fn pool_size() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
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
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
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
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
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

/// 다른 연결의 열린 transaction이 table의 모든 행을 갱신해 잡고 있는 lock이다(MySQL,
/// PostgreSQL). `release`가 그 transaction을 rollback한다.
enum HeldRows {
    MySql(sqlx::Transaction<'static, sqlx::MySql>),
    Postgres(sqlx::Transaction<'static, sqlx::Postgres>),
}

impl HeldRows {
    /// `db`와 다른 연결에서 `table`의 모든 행을 잡는다.
    async fn hold(holder: &Db, table: &str) -> HeldRows {
        match holder.pool() {
            Pool::MySql(pool) => {
                let mut tx = pool.begin().await.expect("begin the holder");
                sqlx::raw_sql(sqlx::AssertSqlSafe(format!("UPDATE `{table}` SET `seq` = `seq`"))).execute(&mut *tx).await.expect("hold the rows");
                HeldRows::MySql(tx)
            }
            Pool::Postgres(pool) => {
                let mut tx = pool.begin().await.expect("begin the holder");
                sqlx::raw_sql(sqlx::AssertSqlSafe(format!("UPDATE \"{table}\" SET \"seq\" = \"seq\""))).execute(&mut *tx).await.expect("hold the rows");
                HeldRows::Postgres(tx)
            }
            Pool::Sqlite(_) => panic!("SQLite has no row lock of another connection"),
        }
    }

    async fn release(self) {
        match self {
            HeldRows::MySql(tx) => tx.rollback().await.expect("release the rows"),
            HeldRows::Postgres(tx) => tx.rollback().await.expect("release the rows"),
        }
    }
}

/// `db`의 transaction에서 `entity`의 행을 FOR UPDATE로 읽는다. 다른 연결이 그 행을 잡고 있으면 기다린다.
async fn locked_read(db: &Db, entity: &'static Entity) -> orm::Result<()> {
    db.transaction(async || {
        let mut core = Core::new(entity);
        core.connect(db);
        core.lock("update");
        orm::model::get(&ZoneEvent::from_core(core)).await.map(drop)
    })
    .retry(0)
    .await
}

/// A statement past the connection timeout returns CANCELED. MySQL bounds
/// SELECT statements with max_execution_time, PostgreSQL bounds every
/// statement, and SQLite has no session timeout. The bounded statement is a
/// locking read of a row that another connection holds.
#[tokio::test]
async fn statement_timeout() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    for driver in ["mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        let cfg = orm::Config { statement_timeout_ms: 200, ..orm::Config::default() };
        let db = Db::connect(database.dsn(), 2, cfg).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
        db.utils().schema().install(&SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
        let mut row = event(&db);
        row.core_mut().set("start_dt", Param::DateTime(NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(0, 0, 0).unwrap()));
        orm::model::create(&mut row).await.unwrap_or_else(|e| panic!("{driver}: create: {e}"));
        let holder = Db::connect(database.dsn(), 1, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
        let held = HeldRows::hold(&holder, "zone_event").await;
        let err = locked_read(&db, &ENTITY).await.expect_err("a statement past the timeout");
        assert_eq!(err.code(), orm::codes::CANCELED, "{driver}: {err}");
        held.release().await;
        holder.close().await;
        db.close().await;
        database.drop().await;
    }
}

/// A pooler in transaction mode hands one server session to every client in
/// turn. Through ORM_TEST_PGBOUNCER_SINGLE_DSN every client shares one server
/// connection, so the statement timeout of one connection bounds only the
/// statements of that connection.
///
/// PgBouncer의 `orm_test_single`은 database가 고정되어 새 case database에 닿지 않는다. 그래서
/// case는 그 database에 자기 이름(`orm_case_<pid>_<counter>`)의 zone table을 두고, 그 table만
/// 끝에서(실패해도) 지운다.
#[tokio::test]
async fn statement_timeout_through_a_pooler() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    let base = require_dsn("ORM_TEST_POSTGRES_DSN");
    let table = CaseTable::reserve(&base);
    // zone document의 table 이름만 바꾼 schema와 그 entity다. Schema와 Entity는 'static 값을 받는다.
    let text = include_str!("../../../../contracts/fixtures/zone.dbs").replace("zone_event", table.name());
    let document = orm::dbspec::parse(&text, &Default::default()).unwrap_or_else(|errors| panic!("{}: {errors:?}", table.name()));
    let manifest = orm::dbspec::manifest(&[&document]).unwrap_or_else(|errors| panic!("{}: {errors:?}", table.name()));
    let schema: &'static Schema =
        Box::leak(Box::new(Schema::new(Box::leak(manifest.manifest_text.into_boxed_str()), Box::leak(manifest.manifest_hash.into_boxed_str()))));
    let entity: &'static Entity = Box::leak(Box::new(Entity {
        name: Box::leak(table.name().to_owned().into_boxed_str()),
        schema,
        new: orm::model::new_boxed::<ZoneEvent>,
        collect: orm::model::collect_boxed::<ZoneEvent>,
    }));
    let setup = Db::connect(&base, 1, orm::Config::default()).await.unwrap();
    setup.utils().schema().install(schema).await.unwrap();
    for _ in 0..3 {
        let mut core = Core::new(entity);
        core.connect(&setup);
        let mut row = ZoneEvent::from_core(core);
        row.core_mut().set("start_dt", Param::DateTime(NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(0, 0, 0).unwrap()));
        orm::model::create(&mut row).await.unwrap();
    }
    // A direct connection holds the rows, so a locking read through the pooler
    // waits for the lock.
    let held = HeldRows::hold(&setup, table.name()).await;
    let single = require_dsn("ORM_TEST_PGBOUNCER_SINGLE_DSN");
    let bounded = Db::connect_schema(&single, schema, 1, orm::Config { statement_timeout_ms: 200, ..orm::Config::default() }).await.unwrap();
    let err = locked_read(&bounded, entity).await.expect_err("the bounded connection through the pooler");
    assert_eq!(err.code(), orm::codes::CANCELED, "the bounded connection through the pooler: {err}");
    let plain = Db::connect_schema(&single, schema, 1, orm::Config::default()).await.unwrap();
    // The holder keeps the rows for a declared 400 ms, past the 200 ms bound of
    // the other connection, so the plain read waits that long and then succeeds.
    let release = async {
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        held.release().await;
    };
    let started = std::time::Instant::now();
    let (read, ()) = tokio::join!(locked_read(&plain, entity), release);
    assert_eq!(read.map_err(|e| e.to_string()), Ok(()), "a connection without a timeout after the bounded one");
    assert!(started.elapsed() >= std::time::Duration::from_millis(200), "the plain read waited {:?}, not past the bound", started.elapsed());
    let held = HeldRows::hold(&setup, table.name()).await;
    let err = locked_read(&bounded, entity).await.expect_err("the bounded connection after the plain one");
    assert_eq!(err.code(), orm::codes::CANCELED, "the bounded connection after the plain one: {err}");
    held.release().await;
    bounded.close().await;
    plain.close().await;
    setup.close().await;
    table.drop().await;
}

/// A PostgreSQL connection reads float8 values exactly in the text format
/// of the simple protocol and in the binary format of prepared statements.
#[tokio::test]
async fn postgres_float_round_trip() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
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
/// connection it ran on stays usable. The statement is an update of a row
/// that another connection holds, so it waits until its future is dropped.
#[tokio::test]
async fn dropping_a_query_cancels_it() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    for driver in ["mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        let db = Db::connect(database.dsn(), 1, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
        db.utils().schema().install(&SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
        let mut row = event(&db);
        row.core_mut().set("start_dt", Param::DateTime(NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(0, 0, 0).unwrap()));
        let mut row = orm::model::create(&mut row).await.unwrap_or_else(|e| panic!("{driver}: create: {e}"));
        let holder = Db::connect(database.dsn(), 1, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
        let held = HeldRows::hold(&holder, "zone_event").await;

        row.core_mut().set("start_dt", Param::DateTime(NaiveDate::from_ymd_opt(2026, 1, 3).unwrap().and_hms_opt(0, 0, 0).unwrap()));
        let started = std::time::Instant::now();
        let dropped = tokio::time::timeout(std::time::Duration::from_millis(300), orm::model::update(&mut row, false)).await;
        assert!(dropped.is_err(), "{driver}: the blocked statement finished");
        if started.elapsed() >= std::time::Duration::from_secs(4) {
            orm_testcase::warning(format_args!("{driver}: dropping waited for the statement"));
        }
        held.release().await;
        holder.close().await;
        // The pool holds one connection, so the next statement proves the
        // cancelled one released it.
        let count = tokio::time::timeout(std::time::Duration::from_secs(5), orm::model::get_count(event(&db).core()))
            .await
            .unwrap_or_else(|_| panic!("{driver}: the connection did not come back"))
            .unwrap_or_else(|e| panic!("{driver}: count after cancellation: {e}"));
        assert_eq!(count, 1, "{driver}: rows after cancellation");
        db.close().await;
        database.drop().await;
    }
}

/// Dropping a transaction future closes its checked-out connection instead
/// of waiting for SQLx's five-second close-on-drop path. On MySQL and
/// PostgreSQL the transaction waits for a row that another connection holds.
#[tokio::test]
async fn dropping_a_transaction_frees_a_single_connection() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        let db = Db::connect(database.dsn(), 1, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
        db.utils().schema().install(&SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
        // MySQL과 PostgreSQL에서는 다른 연결이 미리 만든 행을 잡아 transaction의 locking read가 기다린다.
        let held = if driver == "sqlite" {
            None
        } else {
            let mut row = event(&db);
            row.core_mut().set("start_dt", Param::DateTime(NaiveDate::from_ymd_opt(2026, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap()));
            orm::model::create(&mut row).await.unwrap_or_else(|e| panic!("{driver}: create: {e}"));
            let holder = Db::connect(database.dsn(), 1, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
            let held = HeldRows::hold(&holder, "zone_event").await;
            Some((holder, held))
        };
        let committed = if held.is_some() { 1 } else { 0 };
        let tx_db = db.clone();
        let dropped = tokio::time::timeout(
            std::time::Duration::from_millis(300),
            db.transaction(async || {
                let mut row = event(&tx_db);
                row.core_mut().set("start_dt", Param::DateTime(NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(0, 0, 0).unwrap()));
                orm::model::create(&mut row).await?;
                if driver == "sqlite" {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                } else {
                    let mut core = Core::new(&ENTITY);
                    core.connect(&tx_db);
                    core.lock("update");
                    orm::model::get(&ZoneEvent::from_core(core)).await?;
                }
                Ok::<(), orm::Error>(())
            })
            .retry(0),
        )
        .await;
        assert!(dropped.is_err(), "{driver}: transaction future completed before it was dropped");
        let next = tokio::time::timeout(std::time::Duration::from_secs(2), db.transaction(async || Ok::<(), orm::Error>(())).retry(0)).await;
        assert!(next.is_ok(), "{driver}: single pool connection was not released after transaction drop");
        if let Some((holder, held)) = held {
            held.release().await;
            holder.close().await;
        }
        assert_eq!(orm::model::get_count(event(&db).core()).await.unwrap(), committed, "{driver}: dropped transaction committed");
        db.close().await;
        database.drop().await;
    }
}
