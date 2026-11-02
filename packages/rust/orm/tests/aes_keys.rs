//! AES key configuration: a write with only `aes_keys` and `aes_version`
//! encrypts with `aes_keys[aes_version]`, and an `aes_key` that differs from
//! that key is rejected.

use polyspec_orm_test_support::model_row;

#[path = "common/or_panic.rs"]
mod or_panic;
use or_panic::OrPanic;

use std::collections::BTreeMap;

use polyspec_orm::{Db, Entity, Model, Schema, Val};

#[path = "common/secret_config.rs"]
mod secret_config;
#[path = "common/secret_connected.rs"]
mod secret_connected;
use secret_config::{COLUMNS, SCHEMA};
use secret_connected::connected;

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

/// A row of one AES cell without its version decodes with the INTERNAL code under the assemble `asm`.
fn assert_versionless_row_is_internal(asm: &polyspec_orm::plan::Assemble) {
    let keys = keys(&[(1, "old-key"), (2, "new-key")]);
    assert_eq!(decode_error_code(asm, vec![Val::Str("00".into())], &keys), "INTERNAL");
}

// Requirements: COD-56.
// FCV-2: the case builds a read plan without its version column, an input that no recipe value can hold; it stays native.
#[test]
fn aes_read_plan_without_version_column_is_internal() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    assert_versionless_row_is_internal(&aes_read_assemble_without_version());
}

// Requirements: COD-48.
// FCV-2: the case builds a selected row without its version cell, an input that no recipe value can hold; it stays native.
#[test]
fn aes_read_row_without_version_cell_is_internal() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    assert_versionless_row_is_internal(&aes_read_assemble());
}

/// The assembly of an AES column at index 0 read with its version column at index 1.
fn aes_read_assemble() -> polyspec_orm::plan::Assemble {
    use polyspec_orm::plan::{Assemble, OutCol};
    Assemble {
        entity: "secret_config".to_owned(),
        columns: vec![
            aes_config_column(),
            OutCol { index: 1, name: "aes_key_version".into(), column: "aes_key_version".into(), typ: "int".into(), styles: vec![], hidden: false },
        ],
        aes_version: Some(1),
        ..Default::default()
    }
}

fn aes_read_assemble_without_version() -> polyspec_orm::plan::Assemble {
    use polyspec_orm::plan::Assemble;
    Assemble { entity: "secret_config".to_owned(), columns: vec![aes_config_column()], aes_version: None, ..Default::default() }
}

fn aes_config_column() -> polyspec_orm::plan::OutCol {
    polyspec_orm::plan::OutCol {
        index: 0,
        name: "config".into(),
        column: "config".into(),
        typ: "longblob".into(),
        styles: vec!["aes".into(), "hex".into()],
        hidden: false,
    }
}

fn decode_error_code(assembly: &polyspec_orm::plan::Assemble, row: Vec<Val>, keys: &BTreeMap<i32, String>) -> String {
    let mut data = vec![row];
    match polyspec_orm::row::decode_styled(assembly, &mut data, keys) {
        Ok(()) => String::new(),
        Err(error) => error.code().to_owned(),
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

model_row!(NullAesSecret, NULL_AES_SECRET, COLUMNS);
