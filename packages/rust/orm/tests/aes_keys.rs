//! The read plans and rows of AES that no recipe value can hold (COD-48, COD-56; FCV-2).

use std::collections::BTreeMap;

use polyspec_orm::Val;

fn keys(pairs: &[(i32, &str)]) -> BTreeMap<i32, String> {
    pairs.iter().map(|(v, k)| (*v, (*k).to_owned())).collect()
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
