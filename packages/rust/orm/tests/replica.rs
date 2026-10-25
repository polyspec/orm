//! A connection to the primary and one to its replica side by side (docs/spec/config.md "Primary and replicas"), on
//! MySQL and PostgreSQL, and a connection to a SQLite database file that the process may only read
//! (contracts/fixtures/rollback.dbs). A model uses the connection it is connected to and no other, a model without a
//! connection inside a transaction uses the transaction, and a write through the replica or to the read-only file
//! returns READ_ONLY. Each case runs in a case database of its own (polyspec-orm-case-database) on the servers of
//! ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN, whose replicas ORM_TEST_MYSQL_REPLICA_DSN and
//! ORM_TEST_POSTGRES_REPLICA_DSN name; the test fails when a variable is unset.
// Requirements: CFG-21, CFG-22, CFG-23, CFG-24, CFG-25.

#[macro_use]
#[path = "common/model_row.rs"]
mod model_row;
#[path = "common/model_connect.rs"]
mod model_connect;
use model_connect::{connected, connected_with, with};

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

use std::time::Duration;

use polyspec_orm::core::{Arg, ChainKey};
use polyspec_orm::{Db, Entity, Model, Param, Schema};
use polyspec_orm_case_database::CaseDatabase;

static PROBE_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/rollback.dbs"), "sha256:c57c6748bed0458f6d9843a0e0861ca8ea89c3bde5c4308f2e049b6a87a1203c");
static PROBE: Entity = Entity {
    name: "rollback_probe",
    schema: &PROBE_SCHEMA,
    new: polyspec_orm::model::new_boxed::<Probe>,
    collect: polyspec_orm::model::collect_boxed::<Probe>,
};
const COLUMNS: [&str; 2] = ["seq", "label"];
const CASE_DEADLINE: Duration = Duration::from_secs(120);
const BY_LABEL: &[ChainKey] = &[ChainKey { conn: "", op: "", column: "label", columns: &[], compare: "" }];

model_row!(Probe, PROBE, COLUMNS);

fn required(variable: &str) -> String {
    match std::env::var(variable) {
        Ok(value) if !value.is_empty() => value,
        _ => panic!(
            "{variable} is required; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers"
        ),
    }
}

/// The rows of rollback_probe that db reads with one of the labels.
async fn count(db: &Db, labels: &[&str]) -> i64 {
    let values = labels.iter().map(|label| Param::from(*label)).collect();
    let filter = connected::<Probe>(db).core().by(BY_LABEL, vec![Arg::Value(polyspec_orm::args::Value::List(values))]);
    polyspec_orm::model::get_count(&filter).await.or_panic(|e| format!("count {labels:?}: {e}"))
}

/// Creates a row labeled label through db.
async fn create(db: &Db, label: &str) -> polyspec_orm::Result<Probe> {
    polyspec_orm::model::create(&mut connected_with::<Probe>(db, &[("label", Param::from(label))])).await
}

/// The DSN of dsn with no database selected.
fn without_database(dsn: &str) -> String {
    let (base, query) = dsn.split_once('?').map_or((dsn, None), |(base, query)| (base, Some(query)));
    let authority = base.find("://").map_or(0, |at| at + 3);
    let end = base[authority..].find('/').map_or(base.len(), |at| authority + at);
    match query {
        Some(query) => format!("{}/?{query}", &base[..end]),
        None => format!("{}/", &base[..end]),
    }
}

/// Returns after the replica has applied every change the primary committed before the call. On PostgreSQL a
/// transaction with synchronous_commit=remote_apply that writes WAL, here a transactional logical message, commits after
/// the standby has applied it. On MySQL SOURCE_POS_WAIT on the replica waits for the binary log position of the primary,
/// for at most 60 seconds, since the replica applies the writes of every client that runs in parallel.
async fn await_replica(driver: &str, primary: &str, replica: &str) {
    if driver == "postgres" {
        let pool = sqlx::PgPool::connect(primary).await.or_panic(|e| format!("barrier connection: {e}"));
        let mut tx = pool.begin().await.or_panic(|e| format!("barrier begin: {e}"));
        sqlx::raw_sql("SET LOCAL synchronous_commit = remote_apply").execute(&mut *tx).await.or_panic(|e| format!("barrier mode: {e}"));
        let mode: String =
            sqlx::query_scalar("SELECT current_setting('synchronous_commit') FROM (SELECT pg_logical_emit_message(true, 'orm-test-barrier', '')) AS barrier")
                .fetch_one(&mut *tx)
                .await
                .or_panic(|e| format!("barrier message: {e}"));
        assert_eq!(mode, "remote_apply", "synchronous_commit of the barrier transaction");
        tx.commit().await.or_panic(|e| format!("barrier commit: {e}"));
        pool.close().await;
        return;
    }
    let source = sqlx::MySqlPool::connect(&without_database(primary)).await.or_panic(|e| format!("primary status connection: {e}"));
    let row = sqlx::query("SHOW BINARY LOG STATUS").fetch_one(&source).await.or_panic(|e| format!("binary log status: {e}"));
    let file: String = sqlx::Row::get(&row, 0);
    let position: u64 = sqlx::Row::get(&row, 1);
    source.close().await;
    let target = sqlx::MySqlPool::connect(&without_database(replica)).await.or_panic(|e| format!("replica wait connection: {e}"));
    let waited: Option<i64> =
        sqlx::query_scalar("SELECT SOURCE_POS_WAIT(?, ?, 60)").bind(&file).bind(position).fetch_one(&target).await.or_panic(|e| format!("replica wait: {e}"));
    target.close().await;
    assert!(waited.is_some_and(|n| n >= 0), "the replica did not reach {file}:{position}: {waited:?}");
}

/// Opens a connection to the primary and one to its replica side by side.
async fn primary_and_replica(driver: &str) {
    let database = CaseDatabase::create(driver).await;
    let primary = database.dsn().to_owned();
    let replica = database.related_dsn(&required(&format!("ORM_TEST_{}_REPLICA_DSN", driver.to_uppercase())));
    let run = async {
        let master = Db::connect(&primary, 2, polyspec_orm::Config::default()).await.or_panic(|e| format!("{driver}: primary: {e}"));
        master.utils().schema().install(&PROBE_SCHEMA).await.or_panic(|e| format!("{driver}: install: {e}"));
        let name = format!("replica-{}", std::process::id());
        create(&master, &name).await.or_panic(|e| format!("{driver}: create through the primary: {e}"));
        await_replica(driver, &primary, &replica).await;
        let slave1 = Db::connect_schema(&replica, &PROBE_SCHEMA, 2, polyspec_orm::Config::default()).await.or_panic(|e| format!("{driver}: replica: {e}"));
        assert_eq!(count(&slave1, &[&name]).await, 1, "{driver}: the replica reads the row written through the primary");
        let refused = create(&slave1, &format!("{name}-replica")).await.err().map(|e| e.code().to_owned());
        assert_eq!(refused.as_deref(), Some(polyspec_orm::codes::READ_ONLY), "{driver}: a write through the replica connection");
        assert_eq!(count(&master, &[&format!("{name}-replica")]).await, 0, "{driver}: a write through the replica does not reach the primary");
        // A row read through the replica is written through the primary.
        let filter = connected::<Probe>(&slave1).core().by(BY_LABEL, vec![Arg::Value(polyspec_orm::args::Value::One(Param::from(name.as_str())))]);
        let mut row: Probe =
            polyspec_orm::model::get_core(&filter).await.or_panic(|e| format!("{driver}: read through the replica: {e}")).expect("the replicated row");
        row.core_mut().connect(&master);
        row.core_mut().set("label", Param::from(format!("{name}-renamed").as_str()));
        polyspec_orm::model::update(&mut row, false).await.or_panic(|e| format!("{driver}: update through the primary: {e}"));
        let tx_name = format!("{name}-tx");
        master
            .transaction(async || {
                polyspec_orm::model::create(&mut with::<Probe>(&[("label", Param::from(tx_name.as_str()))])).await?;
                assert_eq!(count(&master, &[&tx_name]).await, 1, "{driver}: the primary connection inside its transaction");
                assert_eq!(count(&slave1, &[&tx_name]).await, 0, "{driver}: the replica connection reads no uncommitted row");
                Ok(())
            })
            .await
            .or_panic(|e| format!("{driver}: transaction: {e}"));
        await_replica(driver, &primary, &replica).await;
        assert_eq!(count(&slave1, &[&format!("{name}-renamed"), &tx_name]).await, 2, "{driver}: the replica reads the committed rows");
        slave1.close().await;
        master.close().await;
    };
    tokio::time::timeout(CASE_DEADLINE, run).await.or_panic(|_| format!("{driver}: the case did not end within {CASE_DEADLINE:?}"));
    database.drop().await;
}

#[tokio::test]
async fn primary_and_replica_mysql() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    primary_and_replica("mysql").await;
}

#[tokio::test]
async fn primary_and_replica_postgres() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    primary_and_replica("postgres").await;
}

/// A connection to a SQLite database file that the process may only read: reads succeed, and a write returns READ_ONLY.
#[tokio::test]
async fn read_only_sqlite() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let database = CaseDatabase::create("sqlite").await;
    let dsn = database.dsn().to_owned();
    let path = database.path().expect("a SQLite case database has a path").to_owned();
    let writable = Db::connect(&dsn, 1, polyspec_orm::Config::default()).await.or_panic(|e| format!("writable: {e}"));
    writable.utils().schema().install(&PROBE_SCHEMA).await.or_panic(|e| format!("install: {e}"));
    create(&writable, "read-only").await.or_panic(|e| format!("create: {e}"));
    writable.close().await;
    let mut permissions = std::fs::metadata(&path).or_panic(|e| format!("{}: {e}", path.display())).permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&path, permissions).or_panic(|e| format!("{}: {e}", path.display()));
    let read_only = Db::connect_schema(&dsn, &PROBE_SCHEMA, 1, polyspec_orm::Config::default()).await.or_panic(|e| format!("read-only: {e}"));
    assert_eq!(count(&read_only, &["read-only"]).await, 1, "the read-only database reads the row");
    let refused = create(&read_only, "rejected").await.err().map(|e| e.code().to_owned());
    assert_eq!(refused.as_deref(), Some(polyspec_orm::codes::READ_ONLY), "a write to the read-only database");
    read_only.close().await;
    database.drop().await;
}
