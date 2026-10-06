//! Encrypted JSON value: a `json aes` column takes an ordered-json value, reads
//! it back byte-for-byte, rotates to another key version, and takes an update, on SQLite,
//! MySQL and PostgreSQL, each in a case database of its own (polyspec-orm-case-database).
//! The test fails when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.

use std::collections::BTreeMap;

use polyspec_orm::db::Pool;
use polyspec_orm::utils::AesKeyring;
use polyspec_orm::{Core, Db, Entity, Model, Param, Schema, Val};
use polyspec_orm_case_database::CaseDatabase;
use sqlx::Row;

// secret_config { bigint seq PK "auto"; int aes_key_version; longblob config "json aes" }
static SCHEMA: Schema =
    Schema::new(include_str!("../../../../contracts/fixtures/secret_config.dbs"), "sha256:c50e5970f7edf30cb5aaa52d291e4ae19ebbdd28040084829ebada1932120f7b");
static SECRET: Entity =
    Entity { name: "secret_config", schema: &SCHEMA, new: polyspec_orm::model::new_boxed::<Secret>, collect: polyspec_orm::model::collect_boxed::<Secret> };
const COLUMNS: [&str; 3] = ["seq", "aes_key_version", "config"];

/// A secret_config row whose values are read and written by column name.
#[derive(Clone)]
struct Secret {
    core: Core,
    values: BTreeMap<String, Val>,
}

impl Model for Secret {
    fn entity() -> &'static Entity {
        &SECRET
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        Secret { core, values: BTreeMap::new() }
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

fn connected(db: &Db) -> Secret {
    let mut core = Core::new(&SECRET);
    core.connect(db);
    Secret::from_core(core)
}

async fn open(dsn: &str, keys: &[(i32, &str)], version: i32) -> Db {
    let keys: BTreeMap<i32, String> = keys.iter().map(|(v, k)| (*v, (*k).to_owned())).collect();
    let config = polyspec_orm::Config { aes_key: keys[&version].clone(), aes_version: version, aes_keys: keys, ..Default::default() };
    Db::connect_schema(dsn, &SCHEMA, 2, config).await.unwrap_or_else(|e| panic!("{dsn}: {e}"))
}

/// The config value of the single row, as its compact ordered-json text.
async fn read(db: &Db) -> String {
    let mut q = connected(db);
    q.core_mut().add_all_columns();
    let rows = polyspec_orm::model::gets(&q).await.unwrap().into_vec();
    assert_eq!(rows.len(), 1, "rows");
    match &rows[0].values["config"] {
        Val::Ordered(v) => v.compact(),
        other => panic!("config is {other:?}"),
    }
}

/// The stored config cell and key version of the single row.
async fn stored(db: &Db) -> (Vec<u8>, i64) {
    let sql = "SELECT config, aes_key_version FROM secret_config";
    match db.pool() {
        Pool::MySql(p) => {
            let row = sqlx::query(sql).fetch_one(p).await.unwrap();
            (row.get(0), i64::from(row.get::<i32, _>(1)))
        }
        Pool::Postgres(p) => {
            let row = sqlx::query(sql).fetch_one(p).await.unwrap();
            (row.get(0), i64::from(row.get::<i32, _>(1)))
        }
        Pool::Sqlite(p) => {
            let row = sqlx::query(sql).fetch_one(p).await.unwrap();
            (row.get(0), row.get(1))
        }
    }
}

#[tokio::test]
async fn aes_json_column() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    // Member order, number text, and {} apart from [] survive the round trip.
    let text = r#"{"token":"s3cret-token","b":1,"a":[],"c":{},"n":1.50,"z":[true,null,"x"]}"#;
    let updated = r#"{"token":"next-token","list":[1,"two",null],"e":{}}"#;
    let one: &[(i32, &str)] = &[(1, "config-key-one")];
    let both: &[(i32, &str)] = &[(1, "config-key-one"), (2, "config-key-two")];
    for driver in ["sqlite", "mysql", "postgres"] {
        let database = CaseDatabase::create(driver).await;
        let dsn = database.dsn();
        let first = open(dsn, one, 1).await;
        first.utils().schema().install(&SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
        let mut row = connected(&first);
        row.core_mut().set_ordered("config", polyspec_orm::ordered_json::parse(text).unwrap());
        let seq = polyspec_orm::model::create(&mut row)
            .await
            .unwrap_or_else(|e| panic!("{driver}: create: {e}"))
            .value("seq")
            .expect("generated seq")
            .as_i64()
            .unwrap();
        assert_eq!(read(&first).await, text, "{driver}: read back");
        let (cell, version) = stored(&first).await;
        assert!(cell.starts_with(b"ORM-AES2\0") && !cell.windows(12).any(|w| w == b"s3cret-token") && version == 1, "{driver}: stored version {version}");

        let second = open(dsn, both, 2).await;
        assert_eq!(read(&second).await, text, "{driver}: mixed-version read");
        let keyring = AesKeyring::new(both.iter().map(|(v, k)| (*v, (*k).to_owned())).collect(), 2).unwrap();
        assert_eq!(second.utils().aes().rotate(&connected(&second), &keyring).await.unwrap(), 1, "{driver}: rotate");
        assert_eq!(stored(&second).await.1, 2, "{driver}: rotated version");
        let rotated = open(dsn, &[(2, "config-key-two")], 2).await;
        assert_eq!(read(&rotated).await, text, "{driver}: rotated read");

        let again = open(dsn, both, 1).await;
        let mut changed = connected(&again);
        changed.core_mut().set("seq", Param::I64(seq));
        changed.core_mut().set_ordered("config", polyspec_orm::ordered_json::parse(updated).unwrap());
        polyspec_orm::model::update(&mut changed, false).await.unwrap_or_else(|e| panic!("{driver}: update: {e}"));
        assert_eq!(stored(&again).await.1, 1, "{driver}: updated version");
        assert_eq!(read(&again).await, updated, "{driver}: updated read");
        for db in [first, second, rotated, again] {
            db.close().await;
        }
        database.drop().await;
    }
}
