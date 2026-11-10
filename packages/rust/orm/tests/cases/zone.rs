//! Connection time zones: every connection reads and writes datetime values in
//! UTC on SQLite, MySQL and PostgreSQL, whatever the server zone (docs/spec/dialects.md
//! "Date and time"); a wall-clock value round-trips and `default now` writes the
//! UTC statement time. A test that installs zone_event does so in a case
//! database of its own (polyspec-orm-case-database). A test fails when
//! ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.

use chrono::{NaiveDate, NaiveDateTime};
use polyspec_orm::db::Pool;
use polyspec_orm::{Core, Db, Entity, Model, Param, Schema};
use polyspec_orm_case_database::CaseDatabase;
use std::time::Duration;

use crate::or_panic;
use or_panic::OrPanic;

/// Removes the directory at path; one that is already gone is not an error, any other failure panics with its cause.
fn remove_dir(path: &std::path::Path) {
    match std::fs::remove_dir_all(path) {
        Ok(()) => {}
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                panic!("remove {}: {error}", path.display());
            }
        }
    }
}

/// Returns the DSN in `var`; an unset or empty variable fails the test.
fn require_dsn(var: &str) -> String {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; run make orm-test-servers, which starts the databases and writes it; run the test through its make target, which reads the environment of make orm-test-servers"),
    }
}

/// A datetime parameter is its canonical text, `YYYY-MM-DD HH:MM:SS.ffffff` in UTC (docs/spec/protocol.md): a native chrono
/// value is refused as CODEC_ENCODE in every client (#T89-3).
fn datetime_param(t: NaiveDateTime) -> Param {
    Param::Str(t.format("%Y-%m-%d %H:%M:%S%.6f").to_string())
}

static SCHEMA: Schema =
    Schema::new(include_str!("../../../../../contracts/fixtures/zone.dbs"), "sha256:c889e6d039d9245e5093d386a7c707419fddf5f9a303d39a5eb7cca4c8499891");

static ENTITY: Entity =
    Entity { name: "zone_event", schema: &SCHEMA, new: polyspec_orm::model::new_boxed::<ZoneEvent>, collect: polyspec_orm::model::collect_boxed::<ZoneEvent> };

typed_model!(ZoneEvent, ENTITY, {
    seq: i64 = "seq",
    start_dt: NaiveDateTime = "start_dt",
    created_ts: NaiveDateTime = "created_ts",
});

fn event(db: &Db) -> ZoneEvent {
    let mut core = Core::new(&ENTITY);
    core.connect(db);
    ZoneEvent::from_core(core)
}

/// A parameter other than `timezone` reaches sqlx, which reads it as its own connect option.
// Requirements: CFG-19, CFG-20, CFG-37, DIA-202.
fn driver_parameters_reach_sqlx() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let parsed = polyspec_orm::db::parse_dsn("postgres://orm@db.local/orm_example?application_name=orm&timezone=UTC").expect("postgres DSN");
    let polyspec_orm::db::ConnectOptions::Postgres(options) = parsed.options else { panic!("not postgres://") };
    assert_eq!(options.get_application_name(), Some("orm"), "application_name reaches sqlx");
    let parsed = polyspec_orm::db::parse_dsn("mysql://orm@db.local/orm_example?socket=/run/mysqld/mysqld.sock").expect("mysql DSN");
    let polyspec_orm::db::ConnectOptions::MySql(options) = parsed.options else { panic!("not mysql://") };
    assert_eq!(options.get_socket().and_then(|path| path.to_str()), Some("/run/mysqld/mysqld.sock"), "socket reaches sqlx");
    // The connection character set is the engine's own, utf8mb4, whatever the DSN names (DIA-202).
    let parsed = polyspec_orm::db::parse_dsn("mysql://orm@db.local/orm_example?charset=latin1").expect("mysql DSN");
    let polyspec_orm::db::ConnectOptions::MySql(options) = parsed.options else { panic!("not mysql://") };
    assert_eq!(options.get_charset(), "utf8mb4", "charset is fixed to utf8mb4");
}

/// A Rust pool opened without `pool_lifetime_ms` keeps the 30-minute lifetime of its pool (CFG-5), which no other client has.
#[tokio::main(flavor = "current_thread")]
// Requirements: CFG-5.
async fn pool_keeps_the_thirty_minute_lifetime_when_unset() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let tmp = std::env::temp_dir().join(format!("orm-rust-pool-lifetime-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let dsn = format!("sqlite://{}", tmp.join("pool.sqlite").display());
    let db = Db::connect(&dsn, 3, polyspec_orm::Config::default()).await.unwrap();
    let Pool::Sqlite(unset) = db.pool().clone() else { unreachable!() };
    assert_eq!(unset.options().get_max_lifetime(), Some(std::time::Duration::from_secs(30 * 60)), "default lifetime");
    db.close().await;
    remove_dir(&tmp);
}

/// An idle direct server connection is discarded; the next statement uses a new one. Poolers may multiplex a client
/// connection without retaining an idle server session, so this lifetime case uses the direct server DSN.
#[tokio::main(flavor = "current_thread")]
// Requirements: INT-92.
async fn pool_discards_ended_idle_connection() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    for driver in ["mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        let server_dsn = database.related_dsn(&require_dsn(&format!("ORM_TEST_{}_SERVER_DSN", driver.to_uppercase())));
        let db = Db::connect(&server_dsn, 1, polyspec_orm::Config { pool_idle_size: 1, ..polyspec_orm::Config::default() })
            .await
            .or_panic(|e| format!("{driver}: connect pool: {e}"));
        assert!(!db.utils().schema().exists("orm").await.or_panic(|e| format!("{driver}: warm pool: {e}")));
        complete_idle_release(&db, driver).await;
        assert_eq!(db.stats().idle, 1, "{driver}: the pool holds one idle connection");

        let admin = Db::connect(&server_dsn, 1, polyspec_orm::Config::default()).await.or_panic(|e| format!("{driver}: connect direct server session: {e}"));
        match admin.pool() {
            Pool::Postgres(pool) => {
                let pids: Vec<i32> = sqlx::query_scalar("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()")
                    .fetch_all(pool)
                    .await
                    .or_panic(|e| format!("{driver}: list case database sessions: {e}"));
                assert_eq!(pids.len(), 1, "{driver}: one idle client session is present");
                let ended: bool = sqlx::query_scalar("SELECT pg_terminate_backend($1, 5000)")
                    .bind(pids[0])
                    .fetch_one(pool)
                    .await
                    .or_panic(|e| format!("{driver}: end idle pool session: {e}"));
                assert!(ended, "{driver}: server ended the idle session");
            }
            Pool::MySql(pool) => {
                let ids: Vec<u64> = sqlx::query_scalar("SELECT ID FROM information_schema.PROCESSLIST WHERE DB = DATABASE() AND ID <> CONNECTION_ID()")
                    .fetch_all(pool)
                    .await
                    .or_panic(|e| format!("{driver}: list case database sessions: {e}"));
                assert_eq!(ids.len(), 1, "{driver}: one idle client session is present");
                sqlx::raw_sql(sqlx::AssertSqlSafe(format!("KILL CONNECTION {}", ids[0])))
                    .execute(pool)
                    .await
                    .or_panic(|e| format!("{driver}: end idle pool session: {e}"));
                let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
                loop {
                    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE ID = ?")
                        .bind(ids[0])
                        .fetch_one(pool)
                        .await
                        .or_panic(|e| format!("{driver}: check ended session: {e}"));
                    if remaining == 0 {
                        break;
                    }
                    assert!(tokio::time::Instant::now() < deadline, "{driver}: server still lists idle session {} after KILL", ids[0]);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
            Pool::Sqlite(_) | Pool::Markdown(_) => unreachable!("server session DSNs select MySQL or PostgreSQL"),
        }
        admin.close().await;
        assert!(!db.utils().schema().exists("orm").await.or_panic(|e| format!("{driver}: statement after server ended idle connection: {e}")));
        complete_idle_release(&db, driver).await;
        assert_eq!(db.stats().idle, 1, "{driver}: the pool retained a replacement connection");
        db.close().await;
        database.drop().await;
    }
}

/// Waits for SQLx to finish returning the sole checked-out connection before reading pool statistics.
async fn complete_idle_release(db: &Db, driver: &str) {
    // SQLx returns a dropped PoolConnection from a spawned task; acquiring the only slot waits for that release.
    match db.pool() {
        Pool::MySql(pool) => {
            pool.acquire().await.or_panic(|e| format!("{driver}: acquire MySQL pool release barrier: {e}")).return_to_pool().await;
        }
        Pool::Postgres(pool) => {
            pool.acquire().await.or_panic(|e| format!("{driver}: acquire PostgreSQL pool release barrier: {e}")).return_to_pool().await;
        }
        Pool::Sqlite(_) | Pool::Markdown(_) => unreachable!("the idle server connection test selects MySQL or PostgreSQL"),
    }
}

/// A lock held by an open transaction on another connection that has updated all rows of the table (MySQL,
/// PostgreSQL). `release` rolls back that transaction.
enum HeldRows {
    MySql(sqlx::Transaction<'static, sqlx::MySql>),
    Postgres(sqlx::Transaction<'static, sqlx::Postgres>),
}

impl HeldRows {
    /// Takes a lock on all rows of `table` from a connection other than `db`.
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
            Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
        }
    }

    async fn release(self) {
        match self {
            HeldRows::MySql(tx) => tx.rollback().await.expect("release the rows"),
            HeldRows::Postgres(tx) => tx.rollback().await.expect("release the rows"),
        }
    }
}

// Rust exposes statement_timeout_ms as u32, so a negative value cannot be represented at this API boundary.
// Requirements: CFG-6, CFG-36.
fn statement_timeout_negative_is_unrepresentable() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let timeout: u32 = polyspec_orm::Config::default().statement_timeout_ms;
    assert_eq!(timeout, 0);
}

/// A PostgreSQL connection reads float8 values exactly in the text format
/// of the simple protocol and in the binary format of prepared statements.
#[tokio::main(flavor = "current_thread")]
// Requirements: CFG-32.
async fn postgres_float_round_trip() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let db = Db::connect(&require_dsn("ORM_TEST_POSTGRES_DSN"), 1, polyspec_orm::Config::default()).await.unwrap();
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
/// `dropping_a_query_cancels_it_mariadb` is the case on MariaDB, a server of the
/// MySQL dialect (DIA-200), which the program mariadb runs (mariadb_trials).
#[tokio::main(flavor = "current_thread")]
// Requirements: CFG-9.
async fn dropping_a_query_cancels_it() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    dropping_a_query_cancels_it_on(&["mysql", "postgres"]).await;
}

#[tokio::main(flavor = "current_thread")]
// Requirements: CFG-9.
async fn dropping_a_query_cancels_it_mariadb() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    dropping_a_query_cancels_it_on(&["mariadb"]).await;
}

async fn dropping_a_query_cancels_it_on(drivers: &[&str]) {
    for &driver in drivers {
        let database = CaseDatabase::create(driver).await;
        let db = Db::connect(database.dsn(), 1, polyspec_orm::Config::default()).await.or_panic(|e| format!("{driver}: {e}"));
        db.utils().schema().install(&SCHEMA).await.or_panic(|e| format!("{driver}: install: {e}"));
        let mut row = event(&db);
        row.core_mut().set("start_dt", datetime_param(NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(0, 0, 0).unwrap()));
        let mut row = polyspec_orm::model::create(&mut row).await.or_panic(|e| format!("{driver}: create: {e}"));
        let holder = Db::connect(database.dsn(), 1, polyspec_orm::Config::default()).await.or_panic(|e| format!("{driver}: {e}"));
        let held = HeldRows::hold(&holder, "zone_event").await;

        row.core_mut().set("start_dt", datetime_param(NaiveDate::from_ymd_opt(2026, 1, 3).unwrap().and_hms_opt(0, 0, 0).unwrap()));
        let started = std::time::Instant::now();
        let dropped = tokio::time::timeout(std::time::Duration::from_millis(300), polyspec_orm::model::update(&mut row, false)).await;
        assert!(dropped.is_err(), "{driver}: the blocked statement finished");
        if started.elapsed() >= std::time::Duration::from_secs(4) {
            polyspec_orm_testcase::warning(format_args!("{driver}: dropping waited for the statement"));
        }
        held.release().await;
        holder.close().await;
        // The pool holds one connection, so the next statement proves the
        // cancelled one released it.
        let count = tokio::time::timeout(std::time::Duration::from_secs(5), polyspec_orm::model::get_count(event(&db).core()))
            .await
            .or_panic(|elapsed| format!("{driver}: the connection did not come back in time: {elapsed}"))
            .or_panic(|e| format!("{driver}: count after cancellation: {e}"));
        assert_eq!(count, 1, "{driver}: rows after cancellation");
        db.close().await;
        database.drop().await;
    }
}

/// Dropping a transaction future closes its checked-out connection instead
/// of waiting for SQLx's five-second close-on-drop path. On MySQL, MariaDB and
/// PostgreSQL the transaction waits for a row that another connection holds.
/// `dropping_a_transaction_frees_a_single_connection_mariadb` is the case on MariaDB (DIA-200).
#[tokio::main(flavor = "current_thread")]
// Requirements: INT-67.
async fn dropping_a_transaction_frees_a_single_connection() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    dropping_a_transaction_frees_a_single_connection_on(&["sqlite", "mysql", "postgres"]).await;
}

#[tokio::main(flavor = "current_thread")]
// Requirements: INT-67.
async fn dropping_a_transaction_frees_a_single_connection_mariadb() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    dropping_a_transaction_frees_a_single_connection_on(&["mariadb"]).await;
}

async fn dropping_a_transaction_frees_a_single_connection_on(drivers: &[&str]) {
    for &driver in drivers {
        let database = CaseDatabase::create(driver).await;
        let db = Db::connect(database.dsn(), 1, polyspec_orm::Config::default()).await.or_panic(|e| format!("{driver}: {e}"));
        db.utils().schema().install(&SCHEMA).await.or_panic(|e| format!("{driver}: install: {e}"));
        // On MySQL and PostgreSQL, the transaction's locking read waits, holding rows that another connection created in advance.
        let held = if driver == "sqlite" {
            None
        } else {
            let mut row = event(&db);
            row.core_mut().set("start_dt", datetime_param(NaiveDate::from_ymd_opt(2026, 1, 1).unwrap().and_hms_opt(0, 0, 0).unwrap()));
            polyspec_orm::model::create(&mut row).await.or_panic(|e| format!("{driver}: create: {e}"));
            let holder = Db::connect(database.dsn(), 1, polyspec_orm::Config::default()).await.or_panic(|e| format!("{driver}: {e}"));
            let held = HeldRows::hold(&holder, "zone_event").await;
            Some((holder, held))
        };
        let committed = if held.is_some() { 1 } else { 0 };
        let tx_db = db.clone();
        let dropped = tokio::time::timeout(
            std::time::Duration::from_millis(300),
            db.transaction(async || {
                let mut row = event(&tx_db);
                row.core_mut().set("start_dt", datetime_param(NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(0, 0, 0).unwrap()));
                polyspec_orm::model::create(&mut row).await?;
                if driver == "sqlite" {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                } else {
                    let mut core = Core::new(&ENTITY);
                    core.connect(&tx_db);
                    core.lock("update");
                    polyspec_orm::model::get(&ZoneEvent::from_core(core)).await?;
                }
                Ok::<(), polyspec_orm::Error>(())
            })
            .retry(0),
        )
        .await;
        assert!(dropped.is_err(), "{driver}: transaction future completed before it was dropped");
        let next = tokio::time::timeout(std::time::Duration::from_secs(2), db.transaction(async || Ok::<(), polyspec_orm::Error>(())).retry(0)).await;
        assert!(next.is_ok(), "{driver}: single pool connection was not released after transaction drop");
        if let Some((holder, held)) = held {
            held.release().await;
            holder.close().await;
        }
        assert_eq!(polyspec_orm::model::get_count(event(&db).core()).await.unwrap(), committed, "{driver}: dropped transaction committed");
        db.close().await;
        database.drop().await;
    }
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("zone": driver_parameters_reach_sqlx, pool_keeps_the_thirty_minute_lifetime_when_unset, pool_discards_ended_idle_connection, statement_timeout_negative_is_unrepresentable, postgres_float_round_trip, dropping_a_query_cancels_it, dropping_a_transaction_frees_a_single_connection)
}

/// The cancellation cases on MariaDB, which need the MariaDB servers; the program mariadb runs them (DIA-200).
pub fn mariadb_trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("zone_mariadb": dropping_a_query_cancels_it_mariadb, dropping_a_transaction_frees_a_single_connection_mariadb)
}
