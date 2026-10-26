//! Direct planner tests for upsert conflict targets, including error paths the public validator normally prevents.

use super::Planner;
use crate::engine::Dialect;
use crate::ir;
use crate::plan::Plan;
use crate::schema::Manifest;
use crate::{codes, Error};

fn manifest() -> Manifest {
    let text = include_str!("../../../../../contracts/fixtures/bench/bench.dbs");
    let document = crate::dbspec::parse(text, &Default::default()).expect("bench document parses").document;
    let set = crate::dbspec::manifest(&[&document]).expect("bench manifest builds");
    Manifest::load(&set.manifest_text, &set.manifest_hash).expect("bench manifest loads")
}

fn insert_request(entity: &str, columns: &[&str]) -> ir::Request {
    ir::Request {
        kind: "insert".into(),
        query: ir::Query { entity: entity.into(), ..Default::default() },
        set: columns.iter().enumerate().map(|(p, column)| ir::Assign { column: (*column).into(), p: Some(p), ..Default::default() }).collect(),
        on_duplicate: vec![ir::Assign { column: columns.last().expect("insert has a value column").to_string(), p: Some(columns.len()), ..Default::default() }],
        n_params: columns.len() + 1,
        ..Default::default()
    }
}

fn error_code(result: &crate::Result<Plan>) -> Option<&str> {
    match result {
        Err(Error::Engine { code, .. }) => Some(code),
        _ => None,
    }
}

#[test]
fn missing_entity_error_is_preserved() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let m = manifest();
    let planner = Planner { m: &m, d: Dialect::Sqlite };
    let result = planner.compile(&ir::Request {
        kind: "insert".into(),
        query: ir::Query { entity: "missing_entity".into(), ..Default::default() },
        ..Default::default()
    });
    assert_eq!(error_code(&result), Some(codes::ENTITY_UNKNOWN), "{result:?}");
}

// Requirements: PRT-6.
#[test]
fn missing_conflict_key_error_is_preserved() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let mut m = manifest();
    let entity = m.model.entities.iter_mut().find(|entity| entity.name == "composite_account").expect("composite_account entity");
    entity.primary_key.clear();
    let planner = Planner { m: &m, d: Dialect::Sqlite };

    let result = planner.compile(&insert_request("composite_account", &["tenant_id", "account_id", "name"]));
    assert_eq!(error_code(&result), Some(codes::IR_INVALID), "{result:?}");
}

// Requirements: PRT-6.
#[test]
fn ambiguous_primary_and_unique_conflict_keys_are_rejected() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let mut m = manifest();
    let entity = m.model.entities.iter_mut().find(|entity| entity.name == "upsert_cell").expect("upsert_cell entity");
    entity.identity = None;
    entity.fields.iter_mut().find(|field| field.name == "seq").expect("identity field").identity = false;
    let planner = Planner { m: &m, d: Dialect::Sqlite };

    let result = planner.compile(&insert_request("upsert_cell", &["seq", "code", "label"]));
    assert_eq!(error_code(&result), Some(codes::IR_INVALID), "{result:?}");
}

// Requirements: PRT-6.
#[test]
fn fully_assigned_composite_primary_key_is_a_valid_conflict_target() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let m = manifest();
    let planner = Planner { m: &m, d: Dialect::Sqlite };
    let plan = planner.compile(&insert_request("composite_account", &["tenant_id", "account_id", "name"])).expect("composite upsert");
    let step = &plan.steps[0];
    assert!(step.sql.contains("ON CONFLICT (\"tenant_id\", \"account_id\") DO UPDATE"), "{}", step.sql);
    assert_eq!(step.bind_slots.len(), 4);
    assert_eq!(step.bind_slots.iter().map(|slot| slot.param).collect::<Vec<_>>(), [0, 1, 2, 3]);
}
