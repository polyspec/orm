//! The typed reads of the runtime model (docs/spec/dbspec.md, "Runtime model"), which a recipe does not call: `i16` and
//! `date` values, `time(p)` text with its own digits, a database default, and a styled SQL NULL. The stored values are in
//! the cases `core_value_types` and `core_styled_null` of the recipe `conformance_verification`. On SQLite, MySQL, and
//! PostgreSQL, each database uses its own
//! case database (polyspec-orm-case-database), and it fails if ORM_TEST_MYSQL_DSN or
//! ORM_TEST_POSTGRES_DSN is missing.

use polyspec_orm_test_support::model_connect;

use polyspec_orm_test_support::model_row;

use crate::or_panic;
use or_panic::OrPanic;

use std::collections::BTreeMap;

use polyspec_orm::{Db, Entity, Model, Param, Schema};
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
  payload text null
  primary key (seq)
  settings {
    select explicit note
    codec payload ordered_json
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

static RECORD: std::sync::LazyLock<Entity> = std::sync::LazyLock::new(|| Entity {
    name: "value_record",
    schema: schema(),
    new: polyspec_orm::model::new_boxed::<Record>,
    collect: polyspec_orm::model::collect_boxed::<Record>,
});

const COLUMNS: [&str; 8] = ["seq", "small", "rank", "code", "opens", "day", "note", "payload"];

model_row!(Record, RECORD, COLUMNS);

fn connected(db: &Db) -> Record {
    model_connect::connected(db)
}

#[tokio::main(flavor = "current_thread")]
// Requirements: INT-99, COD-20.
async fn runtime_value_types() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let uuid = "0f0e0d0c-0b0a-4908-8706-050403020100";
    let day = chrono::NaiveDate::from_ymd_opt(2026, 1, 2).unwrap();
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        let db = Db::connect(database.dsn(), 2, polyspec_orm::Config::default()).await.or_panic(|e| format!("{driver}: {e}"));
        db.utils().schema().install(schema()).await.or_panic(|e| format!("{driver}: install: {e}"));

        let mut row = connected(&db);
        row.core_mut().set("small", Param::from(i16::MIN));
        row.core_mut().set("code", Param::from(uuid));
        row.core_mut().set("opens", Param::from("08:30:00.250"));
        row.core_mut().set("day", Param::Str(day.format("%Y-%m-%d").to_string()));
        polyspec_orm::model::create(&mut row).await.or_panic(|e| format!("{driver}: create: {e}"));

        let got = polyspec_orm::model::get(&connected(&db)).await.or_panic(|e| format!("{driver}: get: {e}")).expect("the created row");
        assert_eq!(got.values["small"].as_i16().unwrap(), i16::MIN, "{driver}: i16");
        assert_eq!(got.values["rank"].as_i16().unwrap(), 3, "{driver}: an omitted column takes the database default");
        assert_eq!(got.values["opens"].as_string().unwrap(), "08:30:00.250", "{driver}: time(3) text");
        assert_eq!(got.values["day"].as_date().unwrap(), day, "{driver}: date");
        assert!(got.values["payload"].is_null(), "{driver}: a selected styled SQL NULL remains SQL NULL on read");
        db.close().await;
        database.drop().await;
        polyspec_orm_testcase::step(format_args!("runtime_value_types {driver}"));
    }
}

pub fn trials() -> Vec<polyspec_orm_testcase::Trial> {
    polyspec_orm_testcase::native_trials!("value_types": runtime_value_types)
}
