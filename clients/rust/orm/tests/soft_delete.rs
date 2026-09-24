//! Soft delete through the model client: reads exclude rows with a
//! deleted_at value and a delete rewrites to a guarded update that sets the
//! timestamp. Statements are captured from SQLite, which every environment
//! provides.

use std::sync::{Arc, Mutex};

use chrono::NaiveDateTime;
use orm::{Config, Core, Db, Entity, Model, Param, Schema, Val};

static SCHEMA: Schema = Schema::new(include_bytes!("../../../../schema/schema.json"), "16198b563e2e3cae");

static ENTITY: Entity =
    Entity { name: "soft_record", schema: &SCHEMA, new: orm::model::new_boxed::<SoftRecord>, collect: orm::model::collect_boxed::<SoftRecord> };

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
    fn assign(&mut self, name: &str, v: Val) -> bool {
        match name {
            "seq" => self.seq = v.as_i64(),
            "name" => self.name = v.as_string(),
            "deleted_at" => self.deleted_at = if v.is_null() { None } else { Some(v.as_datetime()) },
            _ => return false,
        }
        true
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
async fn soft_delete_filters_reads_and_rewrites_deletes() {
    let path = std::env::temp_dir().join(format!("orm-rust-soft-delete-{}.sqlite", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let dsn = format!("sqlite://{}?_pragma=busy_timeout(5000)", path.display());
    let logged: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let hook = logged.clone();
    let config = Config {
        aes_key: "test-aes-key".into(),
        blind_index_key: "test-blind-key".into(),
        on_query: Some(Arc::new(move |sql: &str, _: &[Param], _: std::time::Duration, _: u64, _: Option<&orm::Error>| {
            hook.lock().unwrap().push(sql.to_owned());
        })),
        ..Default::default()
    };
    let db = Db::connect(&dsn, 1, config).await.unwrap();
    db.utils().schema().install(SCHEMA.json()).await.unwrap();
    let mut keep = record(&db);
    keep.core_mut().set("name", Param::Str("keep".into()));
    orm::model::create(&mut keep).await.unwrap();
    let mut gone = record(&db);
    gone.core_mut().set("name", Param::Str("gone".into()));
    orm::model::create(&mut gone).await.unwrap();
    assert_eq!(orm::model::get_count(record(&db).core()).await.unwrap(), 2, "rows before the soft delete");
    let rows = orm::model::gets(&record(&db)).await.unwrap();
    let gone_row = rows.models().find(|r| r.name == "gone").cloned().expect("the gone row is readable");
    orm::model::delete(&gone_row, false).await.unwrap();
    assert_eq!(orm::model::get_count(record(&db).core()).await.unwrap(), 1, "reads exclude soft-deleted rows");
    let names = orm::model::gets(&record(&db)).await.unwrap().models().map(|r| r.name.clone()).collect::<Vec<_>>().join(",");
    assert_eq!(names, "keep", "a soft-deleted row is not readable");
    let statements = logged.lock().unwrap().clone();
    let update = statements.iter().find(|sql| sql.starts_with("UPDATE \"soft_record\"")).expect("delete rewrites to an update");
    assert!(update.contains("SET \"deleted_at\" =") && update.contains("\"deleted_at\" IS NULL"), "guarded soft-delete update: {update}");
    assert!(
        statements.iter().filter(|sql| sql.starts_with("SELECT")).all(|sql| sql.contains("\"deleted_at\" IS NULL")),
        "every read filters soft-deleted rows: {statements:?}"
    );
    db.close().await;
    let _ = std::fs::remove_file(&path);
}
