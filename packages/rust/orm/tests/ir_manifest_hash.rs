//! The manifest hash check of the public planner API `engine::validate`: a request built for another manifest fails with
//! SCHEMA_HASH_MISMATCH. It is not a case of the request validation recipe tests/ir/validate.json, whose ir.validate step
//! builds every request with the manifest hash of its schema.
//! Requirements: PRT-1.

use polyspec_orm::engine::validate;
use polyspec_orm::testing::ir_request::{request, schema as manifest_of};

/// A request whose manifest hash differs from the model's fails with SCHEMA_HASH_MISMATCH.
fn manifest_hash_mismatch() {
    let manifest = manifest_of("contracts/fixtures/bench/bench.dbs");
    let other = format!("sha256:{}", "0".repeat(64));
    assert_ne!(other, manifest.manifest_hash, "the other hash differs from the model's");
    let r = request(&serde_json::json!({"ir_version": 1, "n_params": 0, "kind": "all", "entity": "author"}), &other);
    let got = validate(&manifest, &r).map_err(|e| e.code().to_owned());
    assert_eq!(got, Err("SCHEMA_HASH_MISMATCH".to_owned()), "a request of another manifest");
}

fn main() {
    polyspec_orm_testcase::run(vec![polyspec_orm_testcase::trial("manifest_hash_mismatch".to_owned(), polyspec_orm_testcase::COMPUTE, manifest_hash_mismatch)]);
}
