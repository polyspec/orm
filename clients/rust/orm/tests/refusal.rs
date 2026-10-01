//! Driver errors that the error catalog does not list, and CHECK violations,
//! on SQLite, MySQL and PostgreSQL. refused_row is immutable, so its triggers
//! refuse every update with a database error that the catalog does not list;
//! the client reports it with the code DRIVER, the driver message, and the
//! driver error. Its CHECK constraint refuses a nonpositive amount with
//! CONSTRAINT. The test fails when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN
//! is unset.

use std::time::Duration;

use orm::db::Pool;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};

static REFUSAL_SCHEMA: Schema = Schema::new(include_bytes!("../../../../contracts/fixtures/refusal_schema.json"), "46d6ddfb484dea83");
static REFUSED_ROW: Entity =
    Entity { name: "refused_row", schema: &REFUSAL_SCHEMA, new: orm::model::new_boxed::<RefusedRow>, collect: orm::model::collect_boxed::<RefusedRow> };
const COLUMNS: [&str; 2] = ["seq", "amount"];
const CASE_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct RefusedRow {
    core: Core,
    values: std::collections::BTreeMap<String, Val>,
}

impl Model for RefusedRow {
    fn entity() -> &'static Entity {
        &REFUSED_ROW
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        RefusedRow { core, values: std::collections::BTreeMap::new() }
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

fn connected(db: &Db) -> RefusedRow {
    let mut core = Core::new(&REFUSED_ROW);
    core.connect(db);
    RefusedRow::from_core(core)
}

/// Returns the DSN of a target; an unset or empty variable fails the test.
fn target(driver: &str) -> String {
    if driver == "sqlite" {
        let dir = std::env::temp_dir().join(format!("orm-rust-refusal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("refusal.sqlite");
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
        Pool::MySql(p) => sqlx::raw_sql("DROP TABLE IF EXISTS `refused_row`").execute(p).await.map(|_| ()),
        Pool::Postgres(p) => {
            sqlx::raw_sql(r#"DROP TABLE IF EXISTS "refused_row"; DROP FUNCTION IF EXISTS refused_row_immutable_reject()"#).execute(p).await.map(|_| ())
        }
        Pool::Sqlite(p) => sqlx::raw_sql(r#"DROP TABLE IF EXISTS "refused_row""#).execute(p).await.map(|_| ()),
    };
    result.unwrap_or_else(|e| panic!("drop refused_row: {e}"));
}

async fn installed(driver: &str) -> Db {
    let db = Db::connect(&target(driver), 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
    drop_table(&db).await;
    db.utils().schema().install(REFUSAL_SCHEMA.json()).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    db
}

/// An update that the immutable trigger refuses fails with DRIVER and keeps
/// the driver error.
async fn trigger_refused(driver: &str) {
    let db = installed(driver).await;
    let mut row = connected(&db);
    row.core_mut().set("amount", Param::I64(1));
    let created = orm::model::create(&mut row).await.unwrap_or_else(|e| panic!("{driver}: create: {e}"));
    let seq = created.value("seq").expect("generated seq").as_i64().unwrap();
    let mut changed = connected(&db);
    changed.core_mut().set("seq", Param::I64(seq));
    changed.core_mut().set("amount", Param::I64(2));
    let error = orm::model::update(&mut changed, false).await.expect_err("refused update");
    assert_eq!(error.code(), "DRIVER", "{driver}: refused update {error}");
    assert!(error.to_string().contains("immutable table: refused_row"), "{driver}: refused update message {error}");
    assert!(std::error::Error::source(&error).is_some(), "{driver}: refused update keeps the driver error");
    let mut q = connected(&db);
    q.core_mut().add_all_columns();
    let rows = orm::model::gets(&q).await.unwrap_or_else(|e| panic!("{driver}: gets: {e}")).into_vec();
    assert_eq!(rows.len(), 1, "{driver}: rows");
    assert_eq!(rows[0].values["amount"].as_i64().unwrap(), 1, "{driver}: refused update keeps the row");
    drop_table(&db).await;
    db.close().await;
}

/// An insert that the CHECK constraint refuses fails with CONSTRAINT.
async fn check_refused(driver: &str) {
    let db = installed(driver).await;
    let mut row = connected(&db);
    row.core_mut().set("amount", Param::I64(0));
    let error = orm::model::create(&mut row).await.map(|_| ()).expect_err("refused insert");
    assert_eq!(error.code(), "CONSTRAINT", "{driver}: refused insert {error}");
    assert!(error.to_string().contains("amount_positive"), "{driver}: refused insert message {error}");
    assert!(std::error::Error::source(&error).is_some(), "{driver}: refused insert keeps the driver error");
    assert_eq!(orm::model::get_count(connected(&db).core()).await.unwrap(), 0, "{driver}: refused insert writes no row");
    drop_table(&db).await;
    db.close().await;
}

/// The cases of one database share its refused_row table, so they run one at a time.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn bounded<F: std::future::Future<Output = ()>>(driver: &str, case: F) {
    let _serial = SERIAL.lock().await;
    tokio::time::timeout(CASE_DEADLINE, case).await.unwrap_or_else(|_| panic!("{driver}: timeout after {CASE_DEADLINE:?}"));
}

#[tokio::test]
async fn trigger_refused_sqlite() {
    bounded("sqlite", trigger_refused("sqlite")).await;
}

#[tokio::test]
async fn trigger_refused_mysql() {
    bounded("mysql", trigger_refused("mysql")).await;
}

#[tokio::test]
async fn trigger_refused_postgres() {
    bounded("postgres", trigger_refused("postgres")).await;
}

#[tokio::test]
async fn check_refused_sqlite() {
    bounded("sqlite", check_refused("sqlite")).await;
}

#[tokio::test]
async fn check_refused_mysql() {
    bounded("mysql", check_refused("mysql")).await;
}

#[tokio::test]
async fn check_refused_postgres() {
    bounded("postgres", check_refused("postgres")).await;
}
