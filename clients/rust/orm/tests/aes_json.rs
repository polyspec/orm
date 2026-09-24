//! Encrypted JSON value: a `json aes` column takes a JSON value, reads it back
//! unchanged, rotates to another key version, and takes an update, on SQLite,
//! MySQL and PostgreSQL. The test fails when ORM_TEST_MYSQL_DSN or
//! ORM_TEST_POSTGRES_DSN is unset.

use std::collections::BTreeMap;

use orm::db::Pool;
use orm::utils::AesKeyring;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};
use sqlx::Row;

/// Returns the DSN in `var`; an unset or empty variable fails the test.
fn require_dsn(var: &str) -> String {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; database tests never skip"),
    }
}

// secret_config { bigint seq PK "auto"; int aes_key_version; longblob config "json aes" }
static SCHEMA: Schema = Schema::new(include_bytes!("testdata/aes_json.json"), "e10e4baa11dd59da");
static SECRET: Entity = Entity { name: "secret_config", schema: &SCHEMA, new: orm::model::new_boxed::<Secret>, collect: orm::model::collect_boxed::<Secret> };
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
    fn assign(&mut self, name: &str, v: Val) -> bool {
        if !COLUMNS.contains(&name) {
            return false;
        }
        self.values.insert(name.to_owned(), v);
        true
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
    let config = orm::Config { aes_key: keys[&version].clone(), aes_version: version, aes_keys: keys, ..Default::default() };
    Db::connect(dsn, 2, config).await.unwrap_or_else(|e| panic!("{dsn}: {e}"))
}

/// The config value of the single row, as JSON text.
async fn read(db: &Db) -> String {
    let mut q = connected(db);
    q.core_mut().add_all_columns();
    let rows = orm::model::gets(&q).await.unwrap().into_vec();
    assert_eq!(rows.len(), 1, "rows");
    match &rows[0].values["config"] {
        Val::Json(v) => v.to_string(),
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

async fn drop_table(db: &Db) {
    let sql = sqlx::raw_sql("DROP TABLE IF EXISTS secret_config");
    match db.pool() {
        Pool::MySql(p) => sql.execute(p).await.map(|_| ()),
        Pool::Postgres(p) => sql.execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => sql.execute(p).await.map(|_| ()),
    }
    .unwrap();
}

#[tokio::test]
async fn aes_json_column() {
    let tmp = std::env::temp_dir().join(format!("orm-rust-aes-json-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let targets = [
        ("sqlite", format!("sqlite://{}", tmp.join("aes-json.sqlite").display())),
        ("mysql", require_dsn("ORM_TEST_MYSQL_DSN")),
        ("postgres", require_dsn("ORM_TEST_POSTGRES_DSN")),
    ];
    // serde_json objects keep their keys sorted, so the texts use sorted keys.
    let text = r#"{"a":[true,null,"x"],"n":-12.5,"token":"s3cret-token","z":{"a":[],"b":1}}"#;
    let updated = r#"{"list":[1,"two",null],"token":"next-token"}"#;
    let one: &[(i32, &str)] = &[(1, "config-key-one")];
    let both: &[(i32, &str)] = &[(1, "config-key-one"), (2, "config-key-two")];
    for (driver, dsn) in &targets {
        let first = open(dsn, one, 1).await;
        drop_table(&first).await;
        first.utils().schema().install(SCHEMA.json()).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
        let mut row = connected(&first);
        row.core_mut().set_json("config", serde_json::from_str(text).unwrap());
        let seq = orm::model::create(&mut row).await.unwrap_or_else(|e| panic!("{driver}: create: {e}")).value("seq").unwrap_or_default().as_i64();
        assert_eq!(read(&first).await, text, "{driver}: read back");
        let (cell, version) = stored(&first).await;
        assert!(cell.starts_with(b"ORM-AES2\0") && !cell.windows(12).any(|w| w == b"s3cret-token") && version == 1, "{driver}: stored version {version}");

        let second = open(dsn, both, 2).await;
        assert_eq!(read(&second).await, text, "{driver}: mixed-version read");
        let keyring = AesKeyring::new(both.iter().map(|(v, k)| (*v, (*k).to_owned())).collect(), 2).unwrap();
        assert_eq!(second.utils().aes().rotate(&connected(&second), &keyring).await.unwrap(), 1, "{driver}: rotate");
        assert_eq!(stored(&second).await.1, 2, "{driver}: rotated version");
        assert_eq!(read(&open(dsn, &[(2, "config-key-two")], 2).await).await, text, "{driver}: rotated read");

        let again = open(dsn, both, 1).await;
        let mut changed = connected(&again);
        changed.core_mut().set("seq", Param::I64(seq));
        changed.core_mut().set_json("config", serde_json::from_str(updated).unwrap());
        orm::model::update(&mut changed, false).await.unwrap_or_else(|e| panic!("{driver}: update: {e}"));
        assert_eq!(stored(&again).await.1, 1, "{driver}: updated version");
        assert_eq!(read(&again).await, updated, "{driver}: updated read");
        drop_table(&again).await;
    }
    std::fs::remove_dir_all(&tmp).unwrap();
}
