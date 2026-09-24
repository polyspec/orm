//! AES key configuration: a write with only `aes_keys` and `aes_version`
//! encrypts with `aes_keys[aes_version]`, and an `aes_key` that differs from
//! that key is rejected.

use std::collections::BTreeMap;

use orm::{Core, Db, Entity, Model, Schema, Val};

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

fn keys(pairs: &[(i32, &str)]) -> BTreeMap<i32, String> {
    pairs.iter().map(|(v, k)| (*v, (*k).to_owned())).collect()
}

#[tokio::test]
async fn aes_write_uses_key_of_current_version() {
    let tmp = std::env::temp_dir().join(format!("orm-rust-aes-keys-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let dsn = format!("sqlite://{}", tmp.join("aes-keys.sqlite").display());
    let config = orm::Config { aes_version: 2, aes_keys: keys(&[(1, "config-key-one"), (2, "config-key-two")]), ..Default::default() };
    let writer = Db::connect(&dsn, 2, config).await.unwrap();
    writer.utils().schema().install(SCHEMA.json()).await.unwrap();
    let mut row = connected(&writer);
    row.core_mut().set_ordered("config", orm::ordered_json::parse(r#"{"b":1,"a":[]}"#).unwrap());
    orm::model::create(&mut row).await.unwrap_or_else(|e| panic!("create with aes_keys and aes_version: {e}"));
    let reader = Db::connect(&dsn, 2, orm::Config { aes_version: 2, aes_keys: keys(&[(2, "config-key-two")]), ..Default::default() }).await.unwrap();
    let mut q = connected(&reader);
    q.core_mut().add_all_columns();
    let rows = orm::model::gets(&q).await.unwrap().into_vec();
    match &rows[0].values["config"] {
        Val::Ordered(v) => assert_eq!(v.compact(), r#"{"b":1,"a":[]}"#),
        other => panic!("config is {other:?}"),
    }
    assert_eq!(rows[0].values["aes_key_version"].as_i64(), 2, "stored version");
    let conflict = orm::Config { aes_key: "other-key".into(), aes_version: 1, aes_keys: keys(&[(1, "config-key-one")]), ..Default::default() };
    match Db::connect(&dsn, 2, conflict).await {
        Err(e) => assert!(e.code() == "CONFIG" && e.to_string().contains("aes_key"), "error {e}"),
        Ok(_) => panic!("aes_key that differs from aes_keys[aes_version] was accepted"),
    }
    std::fs::remove_dir_all(&tmp).unwrap();
}
