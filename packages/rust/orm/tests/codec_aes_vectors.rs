//! The AES v2 vectors of tests/codec/aes-vectors.json through the public codec API (`polyspec_orm::codec`), one
//! libtest-mimic trial `aes_vectors::<key>` per vector: the aes hex host stages round-trip the plain text with the
//! key, and the fixed envelope decodes to the plain text.

use polyspec_orm::codec::{host_decode, host_encode};
use polyspec_orm::{Param, Val};
use polyspec_orm_testcase::Trial;

#[derive(serde::Deserialize)]
struct File {
    vectors: Vec<Vector>,
}

#[derive(serde::Deserialize)]
struct Vector {
    key: String,
    plain: String,
    envelope_hex: String,
}

fn vector_case(v: &Vector) {
    let styles = vec!["aes".to_string(), "hex".to_string()];
    let Param::Str(encoded) = host_encode(&Param::Str(v.plain.clone()), &styles, &v.key).expect("encode") else { panic!("aes hex must produce text") };
    assert_eq!(host_decode(&Val::Str(encoded), &styles, &v.key).expect("round trip"), Val::Str(v.plain.clone()), "round trip");
    assert_eq!(host_decode(&Val::Str(v.envelope_hex.clone()), &styles, &v.key).expect("fixed envelope"), Val::Str(v.plain.clone()), "fixed envelope");
}

fn main() {
    let path = polyspec_orm_testcase::manifest_dir().join("../../../tests/codec/aes-vectors.json");
    let file: File = serde_json::from_slice(&std::fs::read(path).expect("aes-vectors.json")).expect("aes-vectors.json");
    assert!(!file.vectors.is_empty(), "aes-vectors.json has no vectors");
    let trials: Vec<Trial> = file
        .vectors
        .into_iter()
        .map(|v| polyspec_orm_testcase::trial(format!("aes_vectors::{}", v.key), polyspec_orm_testcase::COMPUTE, move || vector_case(&v)))
        .collect();
    polyspec_orm_testcase::run(trials);
}
