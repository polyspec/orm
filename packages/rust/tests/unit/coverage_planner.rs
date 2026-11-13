//! planner: the invariants of the planner that the compile
//! recipe tests/planner/compile.json does not state. The compile cases run in tests/planner.rs.
//! The engine's validate is visible only inside the crate, so src/engine/mod.rs makes this file a unit test module.

use super::{validate, Dialect};
use crate::or_panic::OrPanic;
use crate::testing::ir_request::{repository, request, schema};
use serde_json::Value;

/// The first step of the compile recipe case `id`: its schema (repository path), input, and expected statements or error.
fn case(id: &str) -> (String, Value, Value) {
    let path = repository().join("tests/planner/compile.json");
    let recipe: Value =
        serde_json::from_str(&std::fs::read_to_string(&path).or_panic(|e| format!("{}: {e}", path.display()))).or_panic(|e| format!("{}: {e}", path.display()));
    let cases: Vec<&Value> = recipe["cases"].as_array().expect("recipe cases").iter().filter(|c| c["id"] == id).collect();
    let [case] = cases.as_slice() else { panic!("{}: case {id} appears {} times", path.display(), cases.len()) };
    let step = &case["steps"][0];
    let schema = step["schema"].as_str().unwrap_or_else(|| panic!("{id}: the step names no schema"));
    (format!("tests/planner/{schema}"), step["input"].clone(), step["expect"]["none"].clone())
}

/// Tests of planner invariants that are not cases in the public fixture.
mod internal_tests {
    use super::*;

    #[test]
    fn scalar_subquery_missing_column_is_internal() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let (at, input, _) = case("planner_scalar_column_subquery");
        let manifest = schema(&at);
        let mut request = request(&input, &manifest.manifest_hash);
        validate(&manifest, &request).expect("valid scalar subquery passes validation");
        let sub = request.query.columns.as_mut().unwrap().sub.get_mut("first_author").unwrap();
        sub.column = "missing_column".into();
        let error = super::super::planner::Planner { m: &manifest, d: Dialect::Sqlite, server: crate::MySqlServer::MySql }
            .compile(&request)
            .expect_err("planner must reject missing post-validation scalar column");
        assert_eq!(error.kind(), crate::Kind::Internal);
        assert!(error.to_string().contains("author.missing_column"), "{error}");
    }

    #[test]
    fn column_function_metadata_planner_rejects_missing_post_validation_field() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let (at, input, _) = case("planner_column_function_date");
        let manifest = schema(&at);
        let mut request = request(&input, &manifest.manifest_hash);
        validate(&manifest, &request).expect("valid column-function request passes validation");

        let mut invalid_public = request.clone();
        let public_pred = match &mut invalid_public.query.where_.as_mut().unwrap().items[0] {
            crate::ir::Item::Pred { pred } => pred,
            _ => panic!("fixture starts with a predicate"),
        };
        public_pred.column = "missing_column".into();
        let public_error = validate(&manifest, &invalid_public).expect_err("public validation keeps rejecting an unknown column");
        assert_eq!(public_error.kind(), crate::Kind::ColumnUnknown);

        let pred = match &mut request.query.where_.as_mut().unwrap().items[0] {
            crate::ir::Item::Pred { pred } => pred,
            _ => panic!("fixture starts with a predicate"),
        };
        pred.column = "missing_column".into();
        let error = super::super::planner::Planner { m: &manifest, d: Dialect::Sqlite, server: crate::MySqlServer::MySql }
            .compile(&request)
            .expect_err("planner must reject missing post-validation column-function metadata");
        assert_eq!(error.kind(), crate::Kind::Internal);
        assert!(error.to_string().contains("author.missing_column"), "{error}");
    }
}
