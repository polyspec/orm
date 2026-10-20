//! The execution flow of a Rust transaction, on a SQLite file: a transaction is active in the tokio task that opened it,
//! so a task spawned inside the callback has no active transaction and an unconnected model there returns CONFIG, and two
//! statements of the callback that overlap on the transaction connection return CONFIG. The test of DSL-121 and DSL-122
//! (docs/spec/dsl.md "Transactions").

use std::sync::LazyLock;

use polyspec_orm::{Core, Db, Entity, Model, Schema, Val};

/// The manifest text of contracts/fixtures/bench/bench.dbs alone: the document carries comments, which its manifest text
/// leaves out, so the document text itself is not the manifest text.
static MANIFEST_TEXT: LazyLock<String> = LazyLock::new(|| {
    let text = include_str!("../../../../contracts/fixtures/bench/bench.dbs");
    let document = polyspec_orm::dbspec::parse(text, &Default::default()).expect("bench.dbs parses").document;
    polyspec_orm::dbspec::manifest(&[&document]).expect("the manifest of bench.dbs").manifest_text
});

static SCHEMA: LazyLock<Schema> = LazyLock::new(|| Schema::new(&MANIFEST_TEXT, "sha256:349a7152d1ad701b2baf8e7e67e14660ec6a75cdd78d5ec61c430f9f6498a1ed"));

static ENTITY: LazyLock<Entity> = LazyLock::new(|| Entity {
    name: "service",
    schema: &SCHEMA,
    new: polyspec_orm::model::new_boxed::<Service>,
    collect: polyspec_orm::model::collect_boxed::<Service>,
});

#[derive(Clone)]
struct Service {
    core: Core,
    seq: i64,
    name: String,
}

impl Model for Service {
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
        Service { core, seq: 0, name: String::new() }
    }
    fn into_core(self) -> Core {
        self.core
    }
    fn assign(&mut self, name: &str, v: Val) -> polyspec_orm::Result<bool> {
        match name {
            "seq" => self.seq = v.as_i64()?,
            "name" => self.name = v.as_string()?,
            _ => return Ok(false),
        }
        Ok(true)
    }
    fn value(&self, name: &str) -> Option<Val> {
        Some(match name {
            "seq" => Val::I64(self.seq),
            "name" => Val::Str(self.name.clone()),
            _ => return None,
        })
    }
}

/// A service model connected to `db`, or to the active transaction without one.
fn service(db: Option<&Db>) -> Service {
    let mut core = Core::new(&ENTITY);
    if let Some(db) = db {
        core.connect(db);
    }
    Service::from_core(core)
}

/// A new SQLite file with the schema installed, in a directory of its own for one test. The directory is removed
/// when the value is dropped, also when the test fails an assertion and unwinds.
struct Database {
    dsn: String,
    dir: std::path::PathBuf,
}

impl Drop for Database {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.dir) {
            if !std::thread::panicking() {
                panic!("remove {}: {error}", self.dir.display());
            }
        }
    }
}

async fn database(name: &str) -> Database {
    let dir = std::env::temp_dir().join(format!("orm-rust-transaction-flow-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let dsn = format!("sqlite://{}", dir.join(format!("{name}.sqlite")).display());
    let db = Db::connect(&dsn, 1, polyspec_orm::Config::default()).await.unwrap();
    db.utils().schema().install(&SCHEMA).await.unwrap();
    db.close().await;
    Database { dsn, dir }
}

#[tokio::test]
async fn spawned_task_has_no_transaction() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let file = database("spawned").await;
    let db = Db::connect_schema(&file.dsn, &SCHEMA, 1, polyspec_orm::Config::default()).await.unwrap();
    let (inside, spawned) = db
        .transaction(async || {
            let inside = polyspec_orm::model::get_count(service(None).core()).await?;
            let spawned = tokio::spawn(async { polyspec_orm::model::get_count(service(None).core()).await }).await.expect("the spawned task ends");
            Ok((inside, spawned.err().map(|e| e.code().to_owned())))
        })
        .retry(0)
        .await
        .unwrap();
    db.close().await;
    assert_eq!(inside, 0, "the callback reads in its transaction");
    assert_eq!(spawned.as_deref(), Some(polyspec_orm::codes::CONFIG), "a task spawned in the callback has no active transaction");
}

#[tokio::test]
async fn overlapping_statements_on_the_transaction_connection_return_config() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let file = database("overlap").await;
    let db = Db::connect_schema(&file.dsn, &SCHEMA, 1, polyspec_orm::Config::default()).await.unwrap();
    let codes = db
        .transaction(async || {
            let (first, second) = (service(None), service(None));
            let (a, b) = tokio::join!(polyspec_orm::model::get_count(first.core()), polyspec_orm::model::get_count(second.core()));
            Ok([a, b].map(|r| r.err().map(|e| e.code().to_owned())))
        })
        .retry(0)
        .await
        .unwrap();
    db.close().await;
    assert!(
        codes.iter().any(|c| c.as_deref() == Some(polyspec_orm::codes::CONFIG)),
        "two overlapping statements of one transaction gave {codes:?}, without CONFIG"
    );
}
