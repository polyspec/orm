//! Derived blind-index assignments retain their actual AES source and row slot.

use super::{compile, Dialect};
use crate::{ir, test_support::manifest};

const SCHEMA: &str = "dbspec 1 shared\n\
table t {\n\
  id i64\n\
  version i32\n\
  name varchar(191)\n\
  email_a bytes null\n\
  email_b bytes null\n\
  hash varchar(64) null\n\
  primary key (id)\n\
  index ix_t_hash (hash)\n\
  settings {\n\
    codec email_a aes\n\
    codec email_b aes\n\
    aes_version version\n\
    blind_index email_a hash\n\
    blind_index email_b hash\n\
  }\n\
}\n";

fn assign(column: &str, p: usize) -> ir::Assign {
    ir::Assign { column: column.into(), p: Some(p), ..Default::default() }
}

fn assign_null(column: &str) -> ir::Assign {
    ir::Assign { column: column.into(), null: true, ..Default::default() }
}

fn request(manifest_hash: String, set: Vec<ir::Assign>, rows: Vec<Vec<usize>>) -> ir::Request {
    ir::Request {
        ir_version: 1,
        manifest_hash,
        kind: "insert".into(),
        query: ir::Query { entity: "t".into(), ..Default::default() },
        set,
        rows,
        n_params: 6,
        ..Default::default()
    }
}

fn index_params(plan: &crate::plan::Plan) -> Vec<usize> {
    plan.steps
        .iter()
        .flat_map(|step| &step.bind_slots)
        .filter(|slot| slot.host_styles.iter().any(|style| style == "blind_index"))
        .map(|slot| slot.param)
        .collect()
}

fn assert_invalid_derived_source(request: &ir::Request, manifest: &crate::schema::Manifest, context: &str) {
    let error = compile(manifest, Dialect::MySql, request).unwrap_err();
    assert_eq!(error.code(), crate::codes::IR_INVALID, "{context}: {error}");
    let message = error.to_string();
    assert!(message.contains("hash") && message.contains("email_a") && message.contains("email_b"), "{context}: {message}");
}

#[test]
fn multi_row_index_uses_the_assigned_source_column_position() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let manifest = manifest(SCHEMA);
    let request = request(manifest.manifest_hash.clone(), vec![assign("id", 0), assign("name", 1), assign("email_b", 2)], vec![vec![3, 4, 5]]);
    let plan = compile(&manifest, Dialect::MySql, &request).unwrap();
    assert_eq!(index_params(&plan), vec![2, 5]);
}

#[test]
fn ordinary_insert_has_no_blind_index_assignment() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let manifest = manifest(SCHEMA);
    let request = ir::Request {
        ir_version: 1,
        manifest_hash: manifest.manifest_hash.clone(),
        kind: "insert".into(),
        query: ir::Query { entity: "t".into(), ..Default::default() },
        set: vec![assign("id", 0), assign("name", 1)],
        n_params: 2,
        ..Default::default()
    };
    let plan = compile(&manifest, Dialect::MySql, &request).unwrap();
    assert!(index_params(&plan).is_empty());
}

#[test]
fn two_assigned_sources_of_one_derived_target_are_invalid() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let manifest = manifest(SCHEMA);
    let request = request(manifest.manifest_hash.clone(), vec![assign("id", 0), assign("name", 1), assign("email_a", 2), assign("email_b", 3)], vec![]);
    let request = ir::Request { n_params: 4, ..request };
    assert_invalid_derived_source(&request, &manifest, "different source parameters");
}

#[test]
fn two_sources_with_equal_parameter_are_invalid() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let manifest = manifest(SCHEMA);
    let request = request(manifest.manifest_hash.clone(), vec![assign("id", 0), assign("name", 1), assign("email_a", 2), assign("email_b", 2)], vec![]);
    let request = ir::Request { n_params: 3, ..request };
    assert_invalid_derived_source(&request, &manifest, "equal source parameter");
}

#[test]
fn explicit_index_assignment_wins_over_multiple_sources() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let manifest = manifest(SCHEMA);
    let request = request(
        manifest.manifest_hash.clone(),
        vec![assign("id", 0), assign("name", 1), assign("email_a", 2), assign("email_b", 3), assign("hash", 4)],
        vec![],
    );
    let request = ir::Request { n_params: 5, ..request };
    let plan = compile(&manifest, Dialect::MySql, &request).unwrap();
    assert_eq!(plan.steps[0].sql.matches("`hash`").count(), 1, "{}", plan.steps[0].sql);
}

#[test]
fn on_duplicate_rejects_two_sources_deriving_one_target() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let manifest = manifest(SCHEMA);
    let cases = [
        ("different params", vec![assign("email_a", 2), assign("email_b", 3)], 4),
        ("same param", vec![assign("email_a", 2), assign("email_b", 2)], 3),
        ("both null", vec![assign_null("email_a"), assign_null("email_b")], 2),
    ];
    for (name, on_duplicate, n_params) in cases {
        let mut request = request(manifest.manifest_hash.clone(), vec![assign("id", 0), assign("name", 1)], vec![]);
        request.n_params = n_params;
        request.on_duplicate = on_duplicate;
        assert_invalid_derived_source(&request, &manifest, name);
    }
}

#[test]
fn explicit_index_assignment_wins_in_on_duplicate() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let manifest = manifest(SCHEMA);
    let mut request = request(manifest.manifest_hash.clone(), vec![assign("id", 0), assign("name", 1)], vec![]);
    request.n_params = 5;
    request.on_duplicate = vec![assign("email_a", 2), assign("email_b", 3), assign("hash", 4)];
    let plan = compile(&manifest, Dialect::MySql, &request).unwrap();
    assert_eq!(plan.steps[0].sql.matches("`hash`").count(), 1, "{}", plan.steps[0].sql);
}
