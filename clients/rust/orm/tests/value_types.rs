//! runtime model의 value type과 select set (docs/dbspec.md, "Runtime model"): `i16`,
//! `uuid`, `time(p)`, `date` 값이 그대로 돌아오고, `select explicit` column은 default
//! select set에서 빠지며, default가 있는 column을 빼면 database default를 쓰고 default가
//! 없는 NOT NULL column을 빼면 실패한다. SQLite, MySQL, PostgreSQL에서 실행하며
//! ORM_TEST_MYSQL_DSN이나 ORM_TEST_POSTGRES_DSN이 없으면 실패한다.

use std::collections::BTreeMap;

use orm::db::Pool;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};

/// Returns the DSN in `var`; an unset or empty variable fails the test.
fn require_dsn(var: &str) -> String {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; database tests never skip"),
    }
}

const DOCUMENT: &str = "dbspec 1 value_types

table value_record {
  seq i64 identity
  small i16
  rank i16 default 3
  code uuid
  opens time(3)
  day date
  note varchar(20) null
  primary key (seq)
  settings {
    select explicit note
  }
}
";

/// test document의 schema. hash는 dbspec manifest에서 계산한다.
fn schema() -> &'static Schema {
    static SCHEMA: std::sync::OnceLock<&'static Schema> = std::sync::OnceLock::new();
    SCHEMA.get_or_init(|| {
        let document = orm::dbspec::parse(DOCUMENT, &BTreeMap::new()).unwrap();
        let manifest = orm::dbspec::manifest(&[&document]).unwrap();
        assert_eq!(manifest.manifest_text, DOCUMENT, "the test document is its own manifest text");
        Box::leak(Box::new(Schema::new(DOCUMENT, Box::leak(manifest.manifest_hash.into_boxed_str()))))
    })
}

static RECORD: std::sync::OnceLock<Entity> = std::sync::OnceLock::new();

fn entity() -> &'static Entity {
    RECORD.get_or_init(|| Entity { name: "value_record", schema: schema(), new: orm::model::new_boxed::<Record>, collect: orm::model::collect_boxed::<Record> })
}

const COLUMNS: [&str; 7] = ["seq", "small", "rank", "code", "opens", "day", "note"];

#[derive(Clone)]
struct Record {
    core: Core,
    values: BTreeMap<String, Val>,
}

impl Model for Record {
    fn entity() -> &'static Entity {
        entity()
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        Record { core, values: BTreeMap::new() }
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

fn connected(db: &Db) -> Record {
    let mut core = Core::new(entity());
    core.connect(db);
    Record::from_core(core)
}

async fn drop_table(db: &Db) {
    let sql = sqlx::raw_sql("DROP TABLE IF EXISTS value_record");
    match db.pool() {
        Pool::MySql(p) => sql.execute(p).await.map(|_| ()),
        Pool::Postgres(p) => sql.execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => sql.execute(p).await.map(|_| ()),
    }
    .unwrap();
}

fn code<T>(r: orm::Result<T>) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => e.code().to_owned(),
    }
}

#[tokio::test]
async fn runtime_value_types() {
    let started = std::time::Instant::now();
    println!("RUN runtime_value_types");
    let tmp = std::env::temp_dir().join(format!("orm-rust-value-types-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let targets = vec![
        ("sqlite", format!("sqlite://{}", tmp.join("values.sqlite").display())),
        ("mysql", require_dsn("ORM_TEST_MYSQL_DSN")),
        ("postgres", require_dsn("ORM_TEST_POSTGRES_DSN")),
    ];
    let uuid = "0f0e0d0c-0b0a-4908-8706-050403020100";
    let day = chrono::NaiveDate::from_ymd_opt(2026, 1, 2).unwrap();
    for (driver, dsn) in &targets {
        let db = Db::connect(dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
        drop_table(&db).await;
        db.utils().schema().install(schema()).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));

        let mut row = connected(&db);
        row.core_mut().set("small", Param::from(i16::MIN));
        row.core_mut().set("code", Param::from(uuid));
        row.core_mut().set("opens", Param::from("08:30:00.250"));
        row.core_mut().set("day", Param::Date(day));
        row.core_mut().set("note", Param::from("hidden"));
        orm::model::create(&mut row).await.unwrap_or_else(|e| panic!("{driver}: create: {e}"));

        let got = orm::model::get(&connected(&db)).await.unwrap_or_else(|e| panic!("{driver}: get: {e}"));
        assert_eq!(got.values["small"].as_i16().unwrap(), i16::MIN, "{driver}: i16");
        assert_eq!(got.values["rank"].as_i16().unwrap(), 3, "{driver}: an omitted column takes the database default");
        assert_eq!(got.values["code"].as_string().unwrap(), uuid, "{driver}: uuid text");
        assert_eq!(got.values["opens"].as_string().unwrap(), "08:30:00.250", "{driver}: time(3) text");
        assert_eq!(got.values["day"].as_date().unwrap(), day, "{driver}: date");
        assert!(!got.values.contains_key("note"), "{driver}: select explicit leaves the column out of the default select set");
        let mut all = connected(&db);
        all.core_mut().add_column("note");
        let got = orm::model::get(&all).await.unwrap_or_else(|e| panic!("{driver}: get note: {e}"));
        assert_eq!(got.values["note"].as_string().unwrap(), "hidden", "{driver}: an added select explicit column");

        let mut short = connected(&db);
        short.core_mut().set("small", Param::from(1i16));
        short.core_mut().set("code", Param::from(uuid));
        short.core_mut().set("opens", Param::from("08:30:00.25"));
        short.core_mut().set("day", Param::Date(day));
        assert_eq!(code(orm::model::create(&mut short).await), orm::codes::CODEC_ENCODE, "{driver}: time text without p fraction digits");
        let mut missing = connected(&db);
        missing.core_mut().set("code", Param::from(uuid));
        missing.core_mut().set("opens", Param::from("08:30:00.250"));
        missing.core_mut().set("day", Param::Date(day));
        assert_eq!(code(orm::model::create(&mut missing).await), orm::codes::IR_INVALID, "{driver}: an omitted non-null column without a default");

        drop_table(&db).await;
        db.close().await;
        println!("PASS runtime_value_types {driver}");
    }
    let _ = std::fs::remove_dir_all(&tmp);
    println!("PASS runtime_value_types {:?}", started.elapsed());
}
