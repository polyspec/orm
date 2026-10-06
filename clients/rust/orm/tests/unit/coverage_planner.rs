//! planner: contracts/fixtures/planner.json의 `input`에 schema/bench.dbs의 manifest hash를 더해
//! 이 client의 engine으로 각 dialect에서 compile한다. statement(role, sql, bind slot의 param
//! 순서(parent slot은 -1), table)가 `expected[dialect]`와 같거나 error code가 `expected.error`와 같아야 한다.
//! engine의 compile은 crate 안에서만 보이므로 src/engine/mod.rs가 이 file을 unit test module로 둔다.
use super::{compile, Dialect};
use crate::ir;
use crate::schema::Manifest;
use polyspec_orm_case_clock::CaseClock;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::time::Duration;

/// 한 case가 자기 계산에 쓰는 thread CPU 시간의 한도.
const CPU_LIMIT: Duration = Duration::from_secs(10);

const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

fn repository() -> PathBuf {
    polyspec_orm_testcase::manifest_dir().join("../../..")
}

fn bench() -> Manifest {
    let path = repository().join("schema/bench.dbs");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let document = crate::dbspec::parse(&text, &Default::default()).unwrap_or_else(|errors| panic!("{}: {errors:?}", path.display()));
    let set = crate::dbspec::manifest(&[&document]).unwrap_or_else(|errors| panic!("{}: {errors:?}", path.display()));
    Manifest::load(&set.manifest_text, &set.manifest_hash).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// fixture에서 `id` case 하나를 찾아 input과 expected를 돌려준다.
fn case(id: &str) -> (Value, Value) {
    let path = repository().join("contracts/fixtures/planner.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())))
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(fixture["feature"], "planner", "{}: feature", path.display());
    let cases: Vec<&Value> = fixture["cases"].as_array().expect("fixture cases").iter().filter(|c| c["id"] == id).collect();
    let [case] = cases.as_slice() else { panic!("{}: case {id} appears {} times", path.display(), cases.len()) };
    assert_eq!(case["operation"], "compile", "{id}: operation");
    (case["input"].clone(), case["expected"].clone())
}

/// `value`의 member를 읽는다. `allowed` 밖의 member는 그 위치와 함께 거부한다.
fn members<'a>(value: &'a Value, at: &str, allowed: &[&str]) -> &'a Map<String, Value> {
    let object = value.as_object().unwrap_or_else(|| panic!("{at}: expected an object, got {value}"));
    for key in object.keys() {
        assert!(allowed.contains(&key.as_str()), "{at}.{key}: unsupported request member");
    }
    object
}

fn string(object: &Map<String, Value>, at: &str, key: &str) -> String {
    object.get(key).and_then(Value::as_str).unwrap_or_else(|| panic!("{at}.{key}: expected a string")).to_owned()
}

fn index(value: &Value, at: &str) -> usize {
    value.as_u64().and_then(|n| usize::try_from(n).ok()).unwrap_or_else(|| panic!("{at}: expected a parameter index, got {value}"))
}

fn count(value: Option<&Value>, at: &str) -> u32 {
    value.and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).unwrap_or_else(|| panic!("{at}: expected a count"))
}

/// column 함수나 value 함수 하나를 IR로 읽는다.
fn func(value: &Value, at: &str) -> ir::Func {
    let object = members(value, at, &["name", "ps"]);
    ir::Func { name: string(object, at, "name"), ps: indexes(object, at, "ps") }
}

/// `key`의 parameter 번호 목록이며 없으면 비어 있다.
fn indexes(object: &Map<String, Value>, at: &str, key: &str) -> Vec<usize> {
    object
        .get(key)
        .map(|ps| ps.as_array().unwrap_or_else(|| panic!("{at}.{key}: expected an array")).iter().map(|p| index(p, &format!("{at}.{key}"))).collect())
        .unwrap_or_default()
}

/// write의 assignment 목록을 IR로 읽는다.
fn assigns(value: &Value, at: &str) -> Vec<ir::Assign> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("{at}: expected an array"))
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let at = format!("{at}[{i}]");
            let a = members(a, &at, &["column", "p", "plus_p", "minus_p"]);
            ir::Assign {
                column: string(a, &at, "column"),
                p: a.get("p").map(|p| index(p, &format!("{at}.p"))),
                plus_p: a.get("plus_p").map(|p| index(p, &format!("{at}.plus_p"))),
                minus_p: a.get("minus_p").map(|p| index(p, &format!("{at}.minus_p"))),
                ..Default::default()
            }
        })
        .collect()
}

fn group(value: &Value, at: &str) -> ir::Group {
    let object = members(value, at, &["conn", "not", "items"]);
    let items = object.get("items").and_then(Value::as_array).unwrap_or_else(|| panic!("{at}.items: expected an array"));
    let items = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let at = format!("{at}.items[{i}]");
            if let Some(nested) = members(item, &at, &["pred", "group"]).get("group") {
                return ir::Item::Group { group: group(nested, &format!("{at}.group")) };
            }
            let pred = members(
                members(item, &at, &["pred", "group"]).get("pred").unwrap_or_else(|| panic!("{at}: expected pred")),
                &format!("{at}.pred"),
                &["conn", "column", "op", "p", "ps", "sub", "fn", "value"],
            );
            let at = format!("{at}.pred");
            ir::Item::Pred {
                pred: Box::new(ir::Pred {
                    conn: pred.get("conn").map(|_| string(pred, &at, "conn")).unwrap_or_default(),
                    column: string(pred, &at, "column"),
                    op: string(pred, &at, "op"),
                    p: pred.get("p").map(|p| index(p, &format!("{at}.p"))),
                    ps: pred
                        .get("ps")
                        .map(|ps| ps.as_array().unwrap_or_else(|| panic!("{at}.ps: expected an array")).iter().map(|p| index(p, &format!("{at}.ps"))).collect())
                        .unwrap_or_default(),
                    r#fn: pred.get("fn").map(|f| func(f, &format!("{at}.fn"))),
                    value: pred.get("value").map(|f| func(f, &format!("{at}.value"))),
                    sub: pred.get("sub").map(|sub| {
                        let at = format!("{at}.sub");
                        let object = members(sub, &at, &["query", "column", "agg"]);
                        ir::Sub {
                            query: Box::new(query(object.get("query").unwrap_or_else(|| panic!("{at}.query: expected a query")), &format!("{at}.query"))),
                            column: object.get("column").map(|_| string(object, &at, "column")).unwrap_or_default(),
                            agg: object.get("agg").map(|_| string(object, &at, "agg")).unwrap_or_default(),
                        }
                    }),
                    ..Default::default()
                }),
            }
        })
        .collect();
    ir::Group {
        conn: object.get("conn").map(|_| string(object, at, "conn")).unwrap_or_default(),
        not: object.get("not").map(|n| n.as_bool().unwrap_or_else(|| panic!("{at}.not: expected a boolean"))).unwrap_or(false),
        items,
    }
}

/// query 하나를 IR로 읽는다: entity, where, join, relation, order, limit.
fn query(value: &Value, at: &str) -> ir::Query {
    let object = members(value, at, &["entity", "where", "joins", "relations", "order", "limit"]);
    let limit = object.get("limit").map(|limit| {
        let at = format!("{at}.limit");
        let limit = members(limit, &at, &["count", "offset"]);
        ir::Limit { count: count(limit.get("count"), &format!("{at}.count")), offset: count(limit.get("offset"), &format!("{at}.offset")) }
    });
    let list = |key: &str| -> Vec<(String, &Value)> {
        object
            .get(key)
            .map(|items| {
                items
                    .as_array()
                    .unwrap_or_else(|| panic!("{at}.{key}: expected an array"))
                    .iter()
                    .enumerate()
                    .map(|(i, item)| (format!("{at}.{key}[{i}]"), item))
                    .collect()
            })
            .unwrap_or_default()
    };
    let order = list("order")
        .into_iter()
        .map(|(at, o)| {
            let o = members(o, &at, &["column", "desc"]);
            ir::Order {
                column: string(o, &at, "column"),
                desc: o.get("desc").map(|d| d.as_bool().unwrap_or_else(|| panic!("{at}.desc: expected a boolean"))).unwrap_or(false),
                ..Default::default()
            }
        })
        .collect();
    let joins = list("joins")
        .into_iter()
        .map(|(at, j)| {
            let j = members(j, &at, &["rel", "kind", "left", "right", "query"]);
            ir::Join {
                rel: string(j, &at, "rel"),
                kind: string(j, &at, "kind"),
                left: string(j, &at, "left"),
                right: string(j, &at, "right"),
                query: Box::new(query(j.get("query").unwrap_or_else(|| panic!("{at}.query: expected a query")), &format!("{at}.query"))),
            }
        })
        .collect();
    let relations = list("relations")
        .into_iter()
        .map(|(at, r)| {
            let r = members(r, &at, &["rel", "kind", "keys", "query"]);
            let keys = r
                .get("keys")
                .and_then(Value::as_array)
                .unwrap_or_else(|| panic!("{at}.keys: expected an array"))
                .iter()
                .map(|k| {
                    let k = members(k, &format!("{at}.keys"), &["left", "right"]);
                    ir::KeyPair { left: string(k, &at, "left"), right: string(k, &at, "right") }
                })
                .collect();
            ir::Relation {
                rel: string(r, &at, "rel"),
                kind: string(r, &at, "kind"),
                keys,
                query: Box::new(query(r.get("query").unwrap_or_else(|| panic!("{at}.query: expected a query")), &format!("{at}.query"))),
            }
        })
        .collect();
    ir::Query {
        entity: string(object, at, "entity"),
        where_: object.get("where").map(|w| group(w, &format!("{at}.where"))),
        joins,
        relations,
        order,
        limit,
        ..Default::default()
    }
}

/// fixture의 request를 IR로 읽는다. 지원하지 않는 member는 거부하고, 읽은 IR을 다시 직렬화한
/// 값이 manifest hash를 더한 입력과 같아야 한다.
fn request(input: &Value, manifest_hash: &str) -> ir::Request {
    let at = "input";
    let object = members(input, at, &["ir_version", "kind", "entity", "n_params", "limit", "order", "where", "joins", "relations", "set", "optimistic"]);
    let mut query_input = input.clone();
    for key in ["ir_version", "kind", "n_params", "set", "optimistic"] {
        query_input.as_object_mut().expect("input object").remove(key);
    }
    let request = ir::Request {
        ir_version: count(object.get("ir_version"), "input.ir_version"),
        manifest_hash: manifest_hash.to_owned(),
        kind: string(object, at, "kind"),
        query: query(&query_input, at),
        n_params: index(object.get("n_params").unwrap_or_else(|| panic!("input.n_params: expected a count")), "input.n_params"),
        set: object.get("set").map(|set| assigns(set, "input.set")).unwrap_or_default(),
        optimistic: object.get("optimistic").map(|o| {
            let o = members(o, "input.optimistic", &["column", "p"]);
            ir::Optimist {
                column: string(o, "input.optimistic", "column"),
                p: index(o.get("p").unwrap_or_else(|| panic!("input.optimistic.p: expected a parameter index")), "input.optimistic.p"),
            }
        }),
        ..Default::default()
    };
    let mut with_hash = input.clone();
    with_hash["manifest_hash"] = json!(manifest_hash);
    assert_eq!(serde_json::to_value(&request).expect("serialized request"), with_hash, "the request read from the fixture differs from its input");
    request
}

fn run(id: &str) {
    let clock = CaseClock::start();
    polyspec_orm_testcase::step(format_args!("start {id}"));
    let manifest = bench();
    let (input, expected) = case(id);
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
                            .map(|slot| match slot.from.as_str() {
                                "param" => json!({"from": slot.from, "param": slot.param, "type": slot.col_type}),
                                "parent" => json!({"from": slot.from, "key_types": slot.key_types}),
                                _ => json!({"from": slot.from, "type": slot.col_type}),
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
