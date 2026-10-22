//! Soft delete through the model client: reads exclude rows with a
//! deleted_at value and a delete rewrites to a guarded update that sets the
//! timestamp. Statements are captured from SQLite, which every environment
//! provides.

use std::sync::{Arc, LazyLock, Mutex};

use chrono::NaiveDateTime;
use polyspec_orm::{Config, Core, Db, Entity, Model, Param, Schema, StatementEvent, Val};

/// A database file of a test: it is removed before the test starts, so an old file of an earlier run is never read, and when the test
/// ends, failed or not. A removal that fails fails the test, unless the test already panics, which then names the file on stderr.
struct TempFile(std::path::PathBuf);

impl TempFile {
    fn fresh(path: std::path::PathBuf) -> Self {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("remove the database file {}: {error}", path.display()),
        }
        TempFile(path)
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        match std::fs::remove_file(&self.0) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) if std::thread::panicking() => eprintln!("remove the database file {}: {error}", self.0.display()),
            Err(error) => panic!("remove the database file {}: {error}", self.0.display()),
        }
    }
}

/// The manifest text of contracts/fixtures/bench/bench.dbs alone: the document carries comments, which its manifest text
/// leaves out, so the document text itself is not the manifest text.
static MANIFEST_TEXT: LazyLock<String> = LazyLock::new(|| {
    let text = include_str!("../../../../contracts/fixtures/bench/bench.dbs");
    let document = polyspec_orm::dbspec::parse(text, &Default::default()).expect("bench.dbs parses").document;
    polyspec_orm::dbspec::manifest(&[&document]).expect("the manifest of bench.dbs").manifest_text
});

static SCHEMA: LazyLock<Schema> = LazyLock::new(|| Schema::new(&MANIFEST_TEXT, "sha256:349a7152d1ad701b2baf8e7e67e14660ec6a75cdd78d5ec61c430f9f6498a1ed"));

static ENTITY: LazyLock<Entity> = LazyLock::new(|| Entity {
    name: "soft_record",
    schema: &SCHEMA,
    new: polyspec_orm::model::new_boxed::<SoftRecord>,
    collect: polyspec_orm::model::collect_boxed::<SoftRecord>,
});

#[derive(Clone)]
struct SoftRecord {
    core: Core,
    seq: i64,
    name: String,
    deleted_at: Option<NaiveDateTime>,
}

impl Model for SoftRecord {
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
        SoftRecord { core, seq: 0, name: String::new(), deleted_at: None }
    }
    fn into_core(self) -> Core {
        self.core
    }
    fn assign(&mut self, name: &str, v: Val) -> polyspec_orm::Result<bool> {
        match name {
            "seq" => self.seq = v.as_i64()?,
            "name" => self.name = v.as_string()?,
            "deleted_at" => self.deleted_at = if v.is_null() { None } else { Some(v.as_datetime()?) },
            _ => return Ok(false),
        }
        Ok(true)
    }
    fn value(&self, name: &str) -> Option<Val> {
        Some(match name {
            "seq" => Val::I64(self.seq),
            "name" => Val::Str(self.name.clone()),
            "deleted_at" => match &self.deleted_at {
                None => Val::Null,
                Some(x) => Val::DateTime(*x),
            },
            _ => return None,
        })
    }
}

fn record(db: &Db) -> SoftRecord {
    let mut core = Core::new(&ENTITY);
    core.connect(db);
    SoftRecord::from_core(core)
}

#[tokio::test]
// Requirements: DBS-67.
async fn soft_delete_filters_reads_and_rewrites_deletes() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let path = std::env::temp_dir().join(format!("orm-rust-soft-delete-{}.sqlite", std::process::id()));
    let _file = TempFile::fresh(path.clone());
    let dsn = format!("sqlite://{}?_pragma=busy_timeout(5000)", path.display());
    let logged: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let hook = logged.clone();
    let config = Config { aes_key: "test-aes-key".into(), blind_index_key: "test-blind-key".into(), ..Default::default() };
    let db = Db::connect(&dsn, 1, config).await.unwrap();
    db.utils().schema().install(&SCHEMA).await.unwrap();
    // Subscribes after install so that only model statements are collected.
    let _logging = db
        .subscribe(move |e: &StatementEvent<'_>| {
            hook.lock().unwrap().push(e.sql.to_owned());
            Ok(())
        })
        .unwrap();
    let mut keep = record(&db);
    keep.core_mut().set("name", Param::Str("keep".into()));
    polyspec_orm::model::create(&mut keep).await.unwrap();
    let mut gone = record(&db);
    gone.core_mut().set("name", Param::Str("gone".into()));
    polyspec_orm::model::create(&mut gone).await.unwrap();
    assert_eq!(polyspec_orm::model::get_count(record(&db).core()).await.unwrap(), 2, "rows before the soft delete");
    let rows = polyspec_orm::model::gets(&record(&db)).await.unwrap();
    let gone_row = rows.models().find(|r| r.name == "gone").cloned().expect("the gone row is readable");
    polyspec_orm::model::delete(&gone_row, false).await.unwrap();
    assert_eq!(polyspec_orm::model::get_count(record(&db).core()).await.unwrap(), 1, "reads exclude soft-deleted rows");
    let names = polyspec_orm::model::gets(&record(&db)).await.unwrap().models().map(|r| r.name.clone()).collect::<Vec<_>>().join(",");
    assert_eq!(names, "keep", "a soft-deleted row is not readable");
    let statements = logged.lock().unwrap().clone();
    let update = statements.iter().find(|sql| sql.starts_with("UPDATE \"soft_record\"")).expect("delete rewrites to an update");
    assert!(update.contains("SET \"deleted_at\" =") && update.contains("\"deleted_at\" IS NULL"), "guarded soft-delete update: {update}");
    assert!(
        statements.iter().filter(|sql| sql.starts_with("SELECT")).all(|sql| sql.contains("\"deleted_at\" IS NULL")),
        "every read filters soft-deleted rows: {statements:?}"
    );
    db.close().await;
}
