//! A transaction or savepoint whose callback fails and whose rollback fails
//! too, on SQLite, MySQL and PostgreSQL. The client reports Error::Rollback
//! with the code ROLLBACK, which keeps the callback error and the rollback
//! error. The callback runs only model calls. On SQLite a trigger of the test
//! fixture raises ROLLBACK when a row labeled `end` is inserted, which ends
//! the transaction, so the client's ROLLBACK finds no transaction. On MySQL
//! and PostgreSQL a test connection ends the server session that holds the
//! transaction, so the next statement and the rollback fail. The test fails
//! when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.

use std::time::Duration;

use orm::db::Pool;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};

static ROLLBACK_SCHEMA: Schema = Schema::new(include_bytes!("../../../../contracts/fixtures/rollback_schema.json"), "49f05d72379c94b4");
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

/// Returns the DSN of a target; an unset or empty variable fails the test.
fn target(driver: &str) -> String {
    if driver == "sqlite" {
        let dir = std::env::temp_dir().join(format!("orm-rust-rollback-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollback.sqlite");
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
        Pool::MySql(p) => sqlx::raw_sql("DROP TABLE IF EXISTS `rollback_probe`").execute(p).await.map(|_| ()),
        Pool::Postgres(p) => sqlx::raw_sql(r#"DROP TABLE IF EXISTS "rollback_probe""#).execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => sqlx::raw_sql(r#"DROP TABLE IF EXISTS "rollback_probe""#).execute(p).await.map(|_| ()),
    };
    result.unwrap_or_else(|e| panic!("drop rollback_probe: {e}"));
}

/// Opens the client, installs the fixture and, on SQLite, the trigger that raises ROLLBACK.
async fn installed(driver: &str) -> (Db, String) {
    let dsn = target(driver);
    let db = Db::connect(&dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
    drop_table(&db).await;
    db.utils().schema().install(ROLLBACK_SCHEMA.json()).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    if let Pool::Sqlite(p) = db.pool() {
        sqlx::raw_sql("CREATE TRIGGER rollback_probe_end BEFORE INSERT ON rollback_probe WHEN NEW.label = 'end' BEGIN SELECT RAISE(ROLLBACK, 'rollback probe ended the transaction'); END")
            .execute(p)
            .await
            .unwrap_or_else(|e| panic!("trigger: {e}"));
    }
    (db, dsn)
}

/// Ends, from a test connection, the server session that holds a lock on
/// rollback_probe; SQLite needs none, its trigger ends the transaction.
async fn end_session(driver: &str, dsn: &str) {
    match driver {
        "postgres" => {
            let pool = sqlx::PgPool::connect(dsn).await.unwrap();
            let pid: i32 = sqlx::query_scalar(
                "SELECT l.pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'rollback_probe' AND l.pid <> pg_backend_pid() LIMIT 1",
            )
            .fetch_one(&pool)
            .await
            .expect("the transaction session holds a lock on rollback_probe");
            sqlx::query("SELECT pg_terminate_backend($1, 5000)").bind(pid).execute(&pool).await.unwrap();
            pool.close().await;
        }
        "mysql" => {
            let pool = sqlx::MySqlPool::connect(dsn).await.unwrap();
            let id: u64 = sqlx::query_scalar("SELECT t.PROCESSLIST_ID FROM performance_schema.data_locks l JOIN performance_schema.threads t ON t.THREAD_ID = l.THREAD_ID WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'rollback_probe' LIMIT 1")
                .fetch_one(&pool)
                .await
                .expect("the transaction session holds a lock on rollback_probe");
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!("KILL {id}"))).execute(&pool).await.unwrap();
            pool.close().await;
        }
        _ => {}
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
async fn rollback_failed(driver: &str) {
    let (db, dsn) = installed(driver).await;
    let error = db
        .transaction(async || {
            create("kept").await?;
            end_session(driver, &dsn).await;
            create("end").await
        })
        .await
        .expect_err("transaction");
    let callback = check_rollback(driver, &error, "transaction");
    if driver == "sqlite" {
        assert!(callback.to_string().contains("rollback probe ended the transaction"), "callback error {callback}");
        assert_eq!(orm::model::get_count(connected(&db).core()).await.unwrap(), 0, "the connection serves later requests");
    }
    db.close().await;
}

/// The callback of a savepoint fails and the savepoint rollback fails, and
/// then the transaction rollback fails.
async fn savepoint_rollback_failed(driver: &str) {
    let (db, dsn) = installed(driver).await;
    let error = db
        .transaction(async || {
            create("kept").await?;
            db.transaction(async || {
                create("nested").await?;
                end_session(driver, &dsn).await;
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

/// The cases of one database share its rollback_probe table, so they run one at a time.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn bounded<F: std::future::Future<Output = ()>>(driver: &str, case: F) {
    let _serial = SERIAL.lock().await;
    tokio::time::timeout(CASE_DEADLINE, case).await.unwrap_or_else(|_| panic!("{driver}: timeout after {CASE_DEADLINE:?}"));
}

#[tokio::test]
async fn rollback_failed_sqlite() {
    bounded("sqlite", rollback_failed("sqlite")).await;
}

#[tokio::test]
async fn rollback_failed_mysql() {
    bounded("mysql", rollback_failed("mysql")).await;
}

#[tokio::test]
async fn rollback_failed_postgres() {
    bounded("postgres", rollback_failed("postgres")).await;
}

#[tokio::test]
async fn savepoint_rollback_failed_sqlite() {
    bounded("sqlite", savepoint_rollback_failed("sqlite")).await;
}

#[tokio::test]
async fn savepoint_rollback_failed_mysql() {
    bounded("mysql", savepoint_rollback_failed("mysql")).await;
}

#[tokio::test]
async fn savepoint_rollback_failed_postgres() {
    bounded("postgres", savepoint_rollback_failed("postgres")).await;
}
