//! planner: contracts/fixtures/planner.json의 `input`에 그 case의 schema 문서의 manifest hash를 더해
//! 이 client의 engine으로 각 dialect에서 compile한다. statement(role, sql, bind slot의 param
//! 순서(parent slot은 -1), table)가 `expected[dialect]`와 같거나 error code가 `expected.error`와 같아야 한다.
//! engine의 compile은 crate 안에서만 보이므로 src/engine/mod.rs가 이 file을 unit test module로 둔다.
use super::ir_request::{members, repository, request, schema};
use super::{compile, Dialect};
use polyspec_orm_case_clock::CaseClock;
use serde_json::{json, Value};
use std::time::Duration;

/// 한 case가 자기 계산에 쓰는 thread CPU 시간의 한도.
const CPU_LIMIT: Duration = Duration::from_secs(10);

const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

fn case(id: &str) -> (String, Value, Value) {
    let path = repository().join("contracts/fixtures/planner.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(fixture["feature"], "planner", "{}: feature", path.display());
    let cases: Vec<&Value> = fixture["cases"].as_array().expect("fixture cases").iter().filter(|c| c["id"] == id).collect();
    let [case] = cases.as_slice() else { panic!("{}: case {id} appears {} times", path.display(), cases.len()) };
    assert_eq!(case["operation"], "compile", "{id}: operation");
    let schema = case["schema"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| panic!("{id}: the case names no schema; give it the repository path of its dbspec document"));
    (schema.to_owned(), case["input"].clone(), case["expected"].clone())
}

fn run(id: &str) {
    let clock = CaseClock::start();
    polyspec_orm_testcase::step(format_args!("start {id}"));
    let (at, input, expected) = case(id);
    let manifest = schema(&at);
    let request = request(&input, &manifest.manifest_hash);
    for (name, dialect) in DIALECTS {
        let got = match compile(&manifest, dialect, &request) {
            Ok(plan) => {
                let statements: Vec<Value> = plan
                    .steps
                    .iter()
                    .map(|step| {
                        let slots: Vec<Value> = step
                            .bind_slots
                            .iter()
                            .map(|slot| {
                                if slot.from == "parent" {
                                    return json!({"from": slot.from, "key_types": slot.key_types});
                                }
                                let mut out = json!({"from": slot.from, "type": slot.col_type});
                                if slot.from == "param" {
                                    out["param"] = json!(slot.param);
                                }
                                // A datetime or time slot carries its fraction digits.
                                if slot.col_type == "datetime" || slot.col_type == "time" {
                                    out["precision"] = json!(slot.precision);
                                }
                                out
                            })
                            .collect();
                        json!({"role": step.role, "sql": step.sql, "slots": slots, "tables": step.tables})
                    })
                    .collect();
                json!(statements)
            }
            Err(error) => json!({"error": error.code()}),
        };
        let want = if expected.get("error").is_some() {
            members(&expected, "expected", &["error"]);
            expected.clone()
        } else {
            expected[name].clone()
        };
        assert!(!want.is_null(), "{id}: no expectation for {name}");
        assert_eq!(got, want, "{id}: {name}");
    }
    let cpu = clock.cpu();
    if cpu >= CPU_LIMIT {
        polyspec_orm_testcase::warning(format_args!("{id}: used {cpu:?} of CPU time, limit {CPU_LIMIT:?}"));
    }
    polyspec_orm_testcase::step(format_args!("{id} cpu={cpu:?} wall={:?}", clock.wall()));
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_statement() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_statement");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_count() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_count");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_contains_binary_collation() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_contains_binary_collation");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_contains_ascii_fold() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_contains_ascii_fold");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_unknown_column() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_unknown_column");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_restore() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_restore");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_restore_rejects_non_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_restore_rejects_non_key");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_restore_key_from_set() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_restore_key_from_set");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_restore_extra_condition() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_restore_extra_condition");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_restore_primary_key_first() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_restore_primary_key_first");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_restore_first_unique_by_name() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_restore_first_unique_by_name");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_tables() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_tables");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_bind_types_select() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_bind_types_select");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_bind_types_update() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_bind_types_update");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_bind_types_insert() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_bind_types_insert");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_time_select() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_time_select");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_time_insert() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_time_insert");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_clock_compare() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_clock_compare");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_clock_insert() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_clock_insert");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_parent_key_types() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_parent_key_types");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_not_group() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_not_group");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_top_not() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_top_not");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_top_group_conn() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_top_group_conn");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_first_item_conn() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_first_item_conn");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_column_refs() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_column_refs");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_ref_unknown_column() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_ref_unknown_column");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_outer_ref_outside_subquery() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_outer_ref_outside_subquery");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_ref_path_absent() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_ref_path_absent");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_unjoined_ref() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_unjoined_ref");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_group_by_count() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_group_by_count");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_group_count_order_column() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_group_count_order_column");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_group_count_order_column_function() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_group_count_order_column_function");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_group_count_order_random() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_group_count_order_random");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_group_by_all() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_group_by_all");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_group_by_sum() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_group_by_sum");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_group_by_join() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_group_by_join");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_group_by_subquery() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_group_by_subquery");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_group_order_non_group_column() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_group_order_non_group_column");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_nullable_key_by() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_nullable_key_by");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_key_by_empty_is_absent() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_key_by_empty_is_absent");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_insert_by_value() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_insert_by_value");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_insert_on_duplicate_plus() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_insert_on_duplicate_plus");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_insert_set_plus() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_insert_set_plus");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_insert_set_minus() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_insert_set_minus");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_ip_eq_col_ip() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_ip_eq_col_ip");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_bool_gt_col() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_bool_gt_col");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_ip_gt_col() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_ip_gt_col");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_aes_eq_col() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_aes_eq_col");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_col_pair_integers() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_col_pair_integers");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_col_pair_integer_varchar() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_col_pair_integer_varchar");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_in_subquery_integer_varchar() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_in_subquery_integer_varchar");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_join_integer_varchar() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_join_integer_varchar");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_relation_integer_varchar() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_relation_integer_varchar");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_upsert_primary_and_unique_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_upsert_primary_and_unique_key");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_upsert_unique_key_not_assigned() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_upsert_unique_key_not_assigned");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_upsert_without_a_key() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_upsert_without_a_key");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_order_nullable_column() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_order_nullable_column");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_order_not_null_column() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_order_not_null_column");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_order_nullable_column_function() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_order_nullable_column_function");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_order_nullable_group_count() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_order_nullable_group_count");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_order_nullable_limit_per_parent() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_order_nullable_limit_per_parent");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_scalar_column_subquery() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_scalar_column_subquery");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_scalar_column_subquery_without_limit() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_scalar_column_subquery_without_limit");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_scalar_column_subquery_without_key_order() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_scalar_column_subquery_without_key_order");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_in_subquery_limit() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    run("planner_rejects_in_subquery_limit");
}
