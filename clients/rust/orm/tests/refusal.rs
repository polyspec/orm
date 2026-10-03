//! Driver errors that the error catalog does not list, and CHECK violations,
//! on SQLite, MySQL and PostgreSQL (contracts/fixtures/refusal.dbs). refused_row is immutable, so its triggers
//! refuse every update with a database error that the catalog does not list;
//! the client reports it with the code DRIVER, the driver message, and the
//! driver error. Its CHECK constraint refuses a nonpositive amount with
//! CONSTRAINT. Each case runs in a case database of its own
//! (orm-case-database). The test fails when ORM_TEST_MYSQL_DSN or
//! ORM_TEST_POSTGRES_DSN is unset.

use std::time::Duration;

use orm::{Core, Db, Entity, Model, Param, Schema, Val};
use orm_case_database::CaseDatabase;

static REFUSAL_SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/refusal.dbs"), "sha256:b4173544710d221d7a8b1802fee458fcd58bd4eb70aba5c07fbfb126a94d017d");
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

async fn installed(driver: &str, dsn: &str) -> Db {
    let db = Db::connect(dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
    db.utils().schema().install(&REFUSAL_SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    db
}

/// An update that the immutable trigger refuses fails with DRIVER and keeps
/// the driver error.
async fn trigger_refused(driver: &str, dsn: &str) {
    let db = installed(driver, dsn).await;
    let mut row = connected(&db);
    row.core_mut().set("amount", Param::I64(1));
    let created = orm::model::create(&mut row).await.unwrap_or_else(|e| panic!("{driver}: create: {e}"));
    let seq = created.value("seq").expect("generated seq").as_i64().unwrap();
    let mut changed = connected(&db);
    changed.core_mut().set("seq", Param::I64(seq));
    changed.core_mut().set("amount", Param::I64(2));
    let error = orm::model::update(&mut changed, false).await.expect_err("refused update");
    assert_eq!(error.code(), "DRIVER", "{driver}: refused update {error}");
    assert!(error.to_string().contains("table refused_row is immutable"), "{driver}: refused update message {error}");
    assert!(std::error::Error::source(&error).is_some(), "{driver}: refused update keeps the driver error");
    let mut q = connected(&db);
    q.core_mut().add_all_columns();
    let rows = orm::model::gets(&q).await.unwrap_or_else(|e| panic!("{driver}: gets: {e}")).into_vec();
    assert_eq!(rows.len(), 1, "{driver}: rows");
    assert_eq!(rows[0].values["amount"].as_i64().unwrap(), 1, "{driver}: refused update keeps the row");
    db.close().await;
}

/// An insert that the CHECK constraint refuses fails with CONSTRAINT.
async fn check_refused(driver: &str, dsn: &str) {
    let db = installed(driver, dsn).await;
    let mut row = connected(&db);
    row.core_mut().set("amount", Param::I64(0));
    let error = orm::model::create(&mut row).await.map(|_| ()).expect_err("refused insert");
    assert_eq!(error.code(), "CONSTRAINT", "{driver}: refused insert {error}");
    assert!(error.to_string().contains("amount_positive"), "{driver}: refused insert message {error}");
    assert!(std::error::Error::source(&error).is_some(), "{driver}: refused insert keeps the driver error");
    assert_eq!(orm::model::get_count(connected(&db).core()).await.unwrap(), 0, "{driver}: refused insert writes no row");
    db.close().await;
}

/// case를 자기만의 case database에서 기한 안에 실행하고, 끝나면 database를 지운다.
async fn bounded(driver: &str, case: &str) {
    let database = CaseDatabase::create(driver).await;
    let run = async {
        match case {
            "trigger" => trigger_refused(driver, database.dsn()).await,
            _ => check_refused(driver, database.dsn()).await,
        }
    };
    tokio::time::timeout(CASE_DEADLINE, run).await.unwrap_or_else(|_| panic!("{driver}: {case}: timeout after {CASE_DEADLINE:?}"));
    database.drop().await;
}

#[tokio::test]
async fn trigger_refused_sqlite() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("sqlite", "trigger").await;
}

#[tokio::test]
async fn trigger_refused_mysql() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("mysql", "trigger").await;
}

#[tokio::test]
async fn trigger_refused_postgres() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("postgres", "trigger").await;
}

#[tokio::test]
async fn check_refused_sqlite() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("sqlite", "check").await;
}

#[tokio::test]
async fn check_refused_mysql() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("mysql", "check").await;
}

#[tokio::test]
async fn check_refused_postgres() {
    let _case = orm_testcase::case!(orm_testcase::DATABASE);
    bounded("postgres", "check").await;
}
