//! AES key configuration: a write with only `aes_keys` and `aes_version`
//! encrypts with `aes_keys[aes_version]`, and an `aes_key` that differs from
//! that key is rejected.

use std::collections::BTreeMap;

use polyspec_orm::{Db, Val};

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
