//! The value types and select sets of the runtime model (docs/spec/dbspec.md, "Runtime model"): `i16`,
//! `uuid`, `time(p)`, and `date` values come back unchanged; a `select explicit` column is left out of the default
//! select set; leaving out a column that has a default uses the database default, and leaving out a NOT NULL column that has no default
//! fails. On SQLite, MySQL, and PostgreSQL, each database uses its own
//! case database (polyspec-orm-case-database), and it fails if ORM_TEST_MYSQL_DSN or
//! ORM_TEST_POSTGRES_DSN is missing.

use std::collections::BTreeMap;

use polyspec_orm::{Core, Db, Entity, Model, Param, Schema, Val};
use polyspec_orm_case_database::CaseDatabase;

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

/// The schema of the test document. The hash is computed from the dbspec manifest.
fn schema() -> &'static Schema {
    static SCHEMA: std::sync::OnceLock<&'static Schema> = std::sync::OnceLock::new();
    SCHEMA.get_or_init(|| {
        let document = polyspec_orm::dbspec::parse(DOCUMENT, &BTreeMap::new()).map(|parsed| parsed.document).unwrap();
        let manifest = polyspec_orm::dbspec::manifest(&[&document]).unwrap();
        assert_eq!(manifest.manifest_text, DOCUMENT, "the test document is its own manifest text");
        Box::leak(Box::new(Schema::new(DOCUMENT, Box::leak(manifest.manifest_hash.into_boxed_str()))))
    })
}

static RECORD: std::sync::OnceLock<Entity> = std::sync::OnceLock::new();

fn entity() -> &'static Entity {
    RECORD.get_or_init(|| Entity {
        name: "value_record",
        schema: schema(),
        new: polyspec_orm::model::new_boxed::<Record>,
        collect: polyspec_orm::model::collect_boxed::<Record>,
    })
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
    fn assign(&mut self, name: &str, v: Val) -> polyspec_orm::Result<bool> {
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

fn code<T>(r: polyspec_orm::Result<T>) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => e.code().to_owned(),
    }
}

#[tokio::test]
// Requirements: INT-99, DBS-68.
async fn runtime_value_types() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let uuid = "0f0e0d0c-0b0a-4908-8706-050403020100";
    let day = chrono::NaiveDate::from_ymd_opt(2026, 1, 2).unwrap();
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        let db = Db::connect(database.dsn(), 2, polyspec_orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
        db.utils().schema().install(schema()).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));

        let mut row = connected(&db);
        row.core_mut().set("small", Param::from(i16::MIN));
        row.core_mut().set("code", Param::from(uuid));
        row.core_mut().set("opens", Param::from("08:30:00.250"));
        row.core_mut().set("day", Param::Str(day.format("%Y-%m-%d").to_string()));
        row.core_mut().set("note", Param::from("hidden"));
        polyspec_orm::model::create(&mut row).await.unwrap_or_else(|e| panic!("{driver}: create: {e}"));

        let got = polyspec_orm::model::get(&connected(&db)).await.unwrap_or_else(|e| panic!("{driver}: get: {e}")).expect("the created row");
        assert_eq!(got.values["small"].as_i16().unwrap(), i16::MIN, "{driver}: i16");
        assert_eq!(got.values["rank"].as_i16().unwrap(), 3, "{driver}: an omitted column takes the database default");
        assert_eq!(got.values["code"].as_string().unwrap(), uuid, "{driver}: uuid text");
        assert_eq!(got.values["opens"].as_string().unwrap(), "08:30:00.250", "{driver}: time(3) text");
        assert_eq!(got.values["day"].as_date().unwrap(), day, "{driver}: date");
        assert!(!got.values.contains_key("note"), "{driver}: select explicit leaves the column out of the default select set");
        let mut all = connected(&db);
        all.core_mut().add_column("note");
        let got = polyspec_orm::model::get(&all).await.unwrap_or_else(|e| panic!("{driver}: get note: {e}")).expect("the created row");
        assert_eq!(got.values["note"].as_string().unwrap(), "hidden", "{driver}: an added select explicit column");

        let mut short = connected(&db);
        short.core_mut().set("small", Param::from(1i16));
        short.core_mut().set("code", Param::from(uuid));
        short.core_mut().set("opens", Param::from("08:30:00.2501"));
        short.core_mut().set("day", Param::Str(day.format("%Y-%m-%d").to_string()));
        assert_eq!(code(polyspec_orm::model::create(&mut short).await), polyspec_orm::codes::CODEC_ENCODE, "{driver}: time text with a non-zero digit past p");
        let mut missing = connected(&db);
        missing.core_mut().set("code", Param::from(uuid));
        missing.core_mut().set("opens", Param::from("08:30:00.250"));
        missing.core_mut().set("day", Param::Str(day.format("%Y-%m-%d").to_string()));
        assert_eq!(
            code(polyspec_orm::model::create(&mut missing).await),
            polyspec_orm::codes::IR_INVALID,
            "{driver}: an omitted non-null column without a default"
        );

        db.close().await;
        database.drop().await;
        polyspec_orm_testcase::step(format_args!("runtime_value_types {driver}"));
    }
}
