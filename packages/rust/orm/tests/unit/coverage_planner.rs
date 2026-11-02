//! planner: the param_uses cases of contracts/fixtures/planner.json, and the invariants of the planner that the compile
//! recipe tests/planner/compile.json does not state. The compile cases run in tests/planner.rs.
//! The engine's param_uses and validate are visible only inside the crate, so src/engine/mod.rs makes this file a unit test module.

use super::{param_uses, validate, Dialect};
use crate::or_panic::OrPanic;
use crate::testing::ir_request::{repository, request, schema};
use polyspec_orm_schema::dbspec::Type;
use serde_json::{json, Value};

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

fn case_of(id: &str, operation: &str) -> (String, Value, Value) {
    let path = repository().join("contracts/fixtures/planner.json");
    let fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(&path).or_panic(|e| format!("{}: {e}", path.display()))).or_panic(|e| format!("{}: {e}", path.display()));
    assert_eq!(fixture["feature"], "planner", "{}: feature", path.display());
    let cases: Vec<&Value> = fixture["cases"].as_array().expect("fixture cases").iter().filter(|c| c["id"] == id).collect();
    let [case] = cases.as_slice() else { panic!("{}: case {id} appears {} times", path.display(), cases.len()) };
    assert_eq!(case["operation"], operation, "{id}: operation");
    let schema = case["schema"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| panic!("{id}: the case names no schema; give it the repository path of its dbspec document"));
    (schema.to_owned(), case["input"].clone(), case["expected"].clone())
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
        let error = super::super::planner::Planner { m: &manifest, d: Dialect::Sqlite }
            .compile(&request)
            .expect_err("planner must reject missing post-validation scalar column");
        assert_eq!(error.code(), crate::codes::INTERNAL);
        assert!(error.to_string().contains("author.missing_column"), "{error}");
    }

    #[test]
    fn scalar_subquery_aggregate_types_remain_i64_and_f64() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        let (at, input, _) = case("planner_scalar_column_subquery");
        let manifest = schema(&at);
        for (agg, column, expected) in [("count", "", "i64"), ("avg", "read_count", "f64")] {
            let mut request = request(&input, &manifest.manifest_hash);
            let sub = request.query.columns.as_mut().unwrap().sub.get_mut("first_author").unwrap();
            sub.agg = agg.into();
            sub.column = column.into();
            sub.query.limit = None;
            sub.query.order.clear();
            validate(&manifest, &request).unwrap();
            let plan = super::super::planner::Planner { m: &manifest, d: Dialect::Sqlite }.compile(&request).unwrap();
            let output = plan.steps[0].assemble.as_ref().unwrap().columns.iter().find(|col| col.name == "first_author").unwrap();
            assert_eq!(output.typ, expected, "{agg}");
        }
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
        assert_eq!(public_error.code(), crate::codes::COLUMN_UNKNOWN);

        let pred = match &mut request.query.where_.as_mut().unwrap().items[0] {
            crate::ir::Item::Pred { pred } => pred,
            _ => panic!("fixture starts with a predicate"),
        };
        pred.column = "missing_column".into();
        let error = super::super::planner::Planner { m: &manifest, d: Dialect::Sqlite }
            .compile(&request)
            .expect_err("planner must reject missing post-validation column-function metadata");
        assert_eq!(error.code(), crate::codes::INTERNAL);
        assert!(error.to_string().contains("author.missing_column"), "{error}");
    }
}

/// The param_uses cases of contracts/fixtures/planner.json, one test `planner::<case id>` per case.
mod planner {
    #[test]
    // Requirements: DIA-31, PRT-67.
    fn param_uses_column_function() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        super::run_param_uses("param_uses_column_function");
    }

    #[test]
    // Requirements: DIA-31, PRT-67.
    fn param_uses_interval() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        super::run_param_uses("param_uses_interval");
    }

    #[test]
    // Requirements: DIA-31, PRT-67.
    fn param_uses_contains() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        super::run_param_uses("param_uses_contains");
    }

    #[test]
    // Requirements: DIA-31, PRT-67.
    fn param_uses_if_parent() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        super::run_param_uses("param_uses_if_parent");
    }

    #[test]
    // Requirements: DIA-31, PRT-67.
    fn param_uses_optimistic() {
        let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
        super::run_param_uses("param_uses_optimistic");
    }
}

/// param_uses case: validates the request and compares the uses of each parameter.
fn run_param_uses(id: &str) {
    let (at, input, expected) = case_of(id, "param_uses");
    let manifest = schema(&at);
    let request = request(&input, &manifest.manifest_hash);
    validate(&manifest, &request).or_panic(|e| format!("{id}: {e}"));
    let got: Vec<Vec<Value>> = param_uses(&manifest, &request)
        .expect("validated request has parameter uses")
        .iter()
        .map(|uses| {
            uses.iter()
                .map(|u| match u.column {
                    None => json!({"type": u.ty}),
                    Some(f) => {
                        let (length, precision, scale): (u32, u32, u32) = match f.ty {
                            Type::Varchar(n) => (n.into(), 0, 0),
                            Type::Decimal(p, s) => (0, p.into(), s.into()),
                            Type::Time(p) | Type::DateTime(p) => (0, p.into(), 0),
                            _ => (0, 0, 0),
                        };
                        let mut out = json!({"type": u.ty, "column": f.name, "length": length, "null": f.nullable, "precision": precision, "scale": scale});
                        if u.assign {
                            out["assign"] = json!(true);
                        }
                        out
                    }
                })
                .collect()
        })
        .collect();
    assert_eq!(json!(got), expected["uses"], "{id}: param uses");
}
