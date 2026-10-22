//! AES key configuration: a write with only `aes_keys` and `aes_version`
//! encrypts with `aes_keys[aes_version]`, and an `aes_key` that differs from
//! that key is rejected.

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

use std::collections::BTreeMap;

use polyspec_orm::db::Pool;
use polyspec_orm::{Core, Db, Entity, Model, Schema, Val};

#[path = "common/secret_config.rs"]
mod secret_config;
#[path = "common/secret_connected.rs"]
mod secret_connected;
use secret_connected::connected;
use secret_config::{COLUMNS, SCHEMA};


fn keys(pairs: &[(i32, &str)]) -> BTreeMap<i32, String> {
    pairs.iter().map(|(v, k)| (*v, (*k).to_owned())).collect()
}

#[tokio::test]
// The test of COD-8 (docs/spec).
async fn invalid_aes_configuration_fails_before_connection() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let cases = [
        ("zero current version", polyspec_orm::Config { aes_version: 0, ..Default::default() }),
        ("negative current version", polyspec_orm::Config { aes_version: -1, ..Default::default() }),
        ("missing current key", polyspec_orm::Config { aes_version: 2, aes_keys: keys(&[(1, "old-key")]), ..Default::default() }),
        ("empty current key", polyspec_orm::Config { aes_keys: keys(&[(1, "")]), ..Default::default() }),
        ("invalid historical version", polyspec_orm::Config { aes_keys: keys(&[(0, "old-key"), (1, "current-key")]), ..Default::default() }),
        ("empty historical key", polyspec_orm::Config { aes_keys: keys(&[(1, "current-key"), (2, "")]), ..Default::default() }),
    ];
    for (name, cfg) in cases {
        match Db::connect("sqlite:///a-path-that-must-not-be-opened/a.sqlite", 1, cfg).await {
            Err(e) => assert_eq!(e.code(), "CONFIG", "{name}: {e}"),
            Ok(_) => panic!("{name} was accepted"),
        }
    }
}

#[tokio::test]
// The test of COD-8 (docs/spec).
async fn aes_write_uses_key_of_current_version() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let tmp = std::env::temp_dir().join(format!("orm-rust-aes-keys-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let dsn = format!("sqlite://{}", tmp.join("aes-keys.sqlite").display());
    let config = polyspec_orm::Config { aes_version: 2, aes_keys: keys(&[(1, "config-key-one"), (2, "config-key-two")]), ..Default::default() };
    let writer = Db::connect(&dsn, 2, config).await.unwrap();
    writer.utils().schema().install(&SCHEMA).await.unwrap();
    let mut row = connected(&writer);
    row.core_mut().set_ordered("config", polyspec_orm::ordered_json::parse(r#"{"b":1,"a":[]}"#).unwrap());
    polyspec_orm::model::create(&mut row).await.or_panic(|e| format!("create with aes_keys and aes_version: {e}"));
    let reader = Db::connect_schema(&dsn, &SCHEMA, 2, polyspec_orm::Config { aes_version: 2, aes_keys: keys(&[(2, "config-key-two")]), ..Default::default() })
        .await
        .unwrap();
    let mut q = connected(&reader);
    q.core_mut().add_all_columns();
    let rows = polyspec_orm::model::gets(&q).await.unwrap().into_vec();
    match &rows[0].values["config"] {
        Val::Ordered(v) => assert_eq!(v.compact(), r#"{"b":1,"a":[]}"#),
        other => panic!("config is {other:?}"),
    }
    assert_eq!(rows[0].values["aes_key_version"].as_i64().unwrap(), 2, "stored version");
    let conflict = polyspec_orm::Config { aes_key: "other-key".into(), aes_version: 1, aes_keys: keys(&[(1, "config-key-one")]), ..Default::default() };
    match Db::connect(&dsn, 2, conflict).await {
        Err(e) => assert!(e.code() == "CONFIG" && e.to_string().contains("aes_key"), "error {e}"),
        Ok(_) => panic!("aes_key that differs from aes_keys[aes_version] was accepted"),
    }
    std::fs::remove_dir_all(&tmp).unwrap();
}

/// The codes of a read row's key version (COD-44): an undeclared version is CONFIG, a stored version that is not a
/// positive 32-bit integer is CODEC_DECODE, and the row is read before any cipher is decoded.
// Requirements: COD-44.
#[test]
fn aes_read_version_codes_match_the_other_clients() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    use polyspec_orm::plan::{Assemble, OutCol};
    let asm = Assemble {
        entity: "secret_config".to_owned(),
        columns: vec![
            OutCol {
                index: 0,
                name: "config".into(),
                column: "config".into(),
                typ: "longblob".into(),
                styles: vec!["aes".into(), "hex".into()],
                hidden: false,
            },
            OutCol { index: 1, name: "aes_key_version".into(), column: "aes_key_version".into(), typ: "int".into(), styles: vec![], hidden: false },
        ],
        aes_version: Some(1),
        ..Default::default()
    };
    let keys = keys(&[(1, "old-key"), (2, "new-key")]);
    let cases = [(Val::Str("abc".into()), "CODEC_DECODE"), (Val::I64(0), "CODEC_DECODE"), (Val::I64(2_147_483_648), "CODEC_DECODE"), (Val::I64(9), "CONFIG")];
    for (version, want) in cases {
        let mut data = vec![vec![Val::Str("00".into()), version.clone()]];
        let got = match polyspec_orm::row::decode_styled(&asm, &mut data, &keys) {
            Ok(()) => String::new(),
            Err(error) => error.code().to_owned(),
        };
        assert_eq!(got, want, "stored version {version:?}");
    }
}

// Requirements: COD-44.
#[test]
fn aes_read_plan_without_version_column_is_internal() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    use polyspec_orm::plan::{Assemble, OutCol};
    let asm = Assemble {
        entity: "secret_config".to_owned(),
        columns: vec![OutCol {
            index: 0,
            name: "config".into(),
            column: "config".into(),
            typ: "longblob".into(),
            styles: vec!["aes".into(), "hex".into()],
            hidden: false,
        }],
        aes_version: None,
        ..Default::default()
    };
    let keys = keys(&[(1, "old-key"), (2, "new-key")]);
    let mut data = vec![vec![Val::Str("00".into())]];
    let got = match polyspec_orm::row::decode_styled(&asm, &mut data, &keys) {
        Ok(()) => String::new(),
        Err(error) => error.code().to_owned(),
    };
    assert_eq!(got, "INTERNAL");
}

// Requirements: COD-44.
#[test]
fn aes_read_keyring_lacks_stored_version_is_config() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let asm = aes_read_assemble();
    let keys = keys(&[(1, "old-key"), (2, "new-key")]);
    let mut data = vec![vec![Val::Str("00".into()), Val::I64(9)]];
    let got = match polyspec_orm::row::decode_styled(&asm, &mut data, &keys) {
        Ok(()) => String::new(),
        Err(error) => error.code().to_owned(),
    };
    assert_eq!(got, "CONFIG");
}

// Requirements: COD-44.
#[test]
fn aes_read_null_version_with_aes_value_is_codec_decode() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let asm = aes_read_assemble();
    let keys = keys(&[(1, "old-key"), (2, "new-key")]);
    let mut data = vec![vec![Val::Str("00".into()), Val::Null]];
    let got = match polyspec_orm::row::decode_styled(&asm, &mut data, &keys) {
        Ok(()) => String::new(),
        Err(error) => error.code().to_owned(),
    };
    assert_eq!(got, "CODEC_DECODE");
}

// Requirements: COD-44.
#[test]
fn aes_read_null_aes_with_null_version_stays_null() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let asm = aes_read_assemble();
    let keys = keys(&[(1, "old-key"), (2, "new-key")]);
    let mut data = vec![vec![Val::Null, Val::Null]];
    polyspec_orm::row::decode_styled(&asm, &mut data, &keys).expect("NULL AES value with NULL version");
    assert_eq!(data[0][0], Val::Null);
}

/// The assembly of an AES column at index 0 read with its version column at index 1.
fn aes_read_assemble() -> polyspec_orm::plan::Assemble {
    use polyspec_orm::plan::{Assemble, OutCol};
    Assemble {
        entity: "secret_config".to_owned(),
        columns: vec![
            OutCol {
                index: 0,
                name: "config".into(),
                column: "config".into(),
                typ: "longblob".into(),
                styles: vec!["aes".into(), "hex".into()],
                hidden: false,
            },
            OutCol { index: 1, name: "aes_key_version".into(), column: "aes_key_version".into(), typ: "int".into(), styles: vec![], hidden: false },
        ],
        aes_version: Some(1),
        ..Default::default()
    }
}

// A copy of secret_config whose AES column may be NULL. The version column stays non-null (COD-6).
const NULL_AES_TEXT: &str = r#"dbspec 1 secret_config_null_aes

table secret_config {
  seq i64 identity
  aes_key_version i32
  config bytes null
  primary key (seq)
  settings {
    select explicit aes_key_version config
    codec config aes
    aes_version aes_key_version
  }
}
"#;
static NULL_AES_SCHEMA: Schema = Schema::new(NULL_AES_TEXT, "sha256:b76a7bc1a184240d8279150252383c3be66e36f01d6ab2b7b4e33045a92b90b2");
static NULL_AES_SECRET: Entity = Entity {
    name: "secret_config",
    schema: &NULL_AES_SCHEMA,
    new: polyspec_orm::model::new_boxed::<NullAesSecret>,
    collect: polyspec_orm::model::collect_boxed::<NullAesSecret>,
};

/// A secret_config row of the NULL-AES schema, read and written by column name.
#[derive(Clone)]
struct NullAesSecret {
    core: Core,
    values: BTreeMap<String, Val>,
}

impl Model for NullAesSecret {
    fn entity() -> &'static Entity {
        &NULL_AES_SECRET
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        NullAesSecret { core, values: BTreeMap::new() }
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

// Requirements: COD-44.
#[tokio::test]
async fn aes_rotate_leaves_null_aes_rows_unchanged() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let tmp = std::env::temp_dir().join(format!("orm-rust-aes-null-value-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let dsn = format!("sqlite://{}", tmp.join("aes-null-value.sqlite").display());
    let config = polyspec_orm::Config { aes_version: 2, aes_keys: keys(&[(1, "config-key-one"), (2, "config-key-two")]), ..Default::default() };
    let db = Db::connect(&dsn, 2, config).await.unwrap();
    db.utils().schema().install(&NULL_AES_SCHEMA).await.unwrap();
    let Pool::Sqlite(p) = db.pool() else { panic!("the NULL-AES test runs on SQLite") };
    // One row whose stored version is not declared and one whose version is valid: neither has an AES value.
    for version in [9_i32, 1] {
        sqlx::query("INSERT INTO secret_config (aes_key_version, config) VALUES (?, NULL)").bind(version).execute(p).await.unwrap();
    }
    let mut core = Core::new(&NULL_AES_SECRET);
    core.connect(&db);
    let model = NullAesSecret::from_core(core);
    let keyring = polyspec_orm::utils::AesKeyring::new(keys(&[(1, "config-key-one"), (2, "config-key-two")]), 2).unwrap();
    let rotated = db.utils().aes().rotate(&model, &keyring).await.or_panic(|e| format!("rotate with NULL AES values: {e}"));
    assert_eq!(rotated, 2, "rotated rows");
    let versions: Vec<i64> = sqlx::query_scalar::<_, i64>("SELECT aes_key_version FROM secret_config ORDER BY seq").fetch_all(p).await.unwrap();
    assert_eq!(versions, vec![2, 2], "stored versions after rotation");
    let nulls: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM secret_config WHERE config IS NULL").fetch_one(p).await.unwrap();
    assert_eq!(nulls, 2, "NULL AES cells after rotation");
    drop(db);
    std::fs::remove_dir_all(&tmp).unwrap();
}
