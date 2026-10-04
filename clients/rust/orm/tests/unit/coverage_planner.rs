//! planner: contracts/fixtures/planner.json의 `input`에 schema/bench.dbs의 manifest hash를 더해
//! 이 client의 engine으로 각 dialect에서 compile한다. statement(role, sql, bind slot의 param
//! 순서(parent slot은 -1), table)가 `expected[dialect]`와 같거나 error code가 `expected.error`와 같아야 한다.
//! engine의 compile은 crate 안에서만 보이므로 src/engine/mod.rs가 이 file을 unit test module로 둔다.
use super::{compile, Dialect};
use crate::ir;
use crate::schema::Manifest;
use orm_case_clock::CaseClock;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::time::Duration;

/// 한 case가 자기 계산에 쓰는 thread CPU 시간의 한도.
const CPU_LIMIT: Duration = Duration::from_secs(10);

const DIALECTS: [(&str, Dialect); 3] = [("mysql", Dialect::MySql), ("postgres", Dialect::Postgres), ("sqlite", Dialect::Sqlite)];

fn repository() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
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

fn group(value: &Value, at: &str) -> ir::Group {
    let object = members(value, at, &["conn", "items"]);
    let items = object.get("items").and_then(Value::as_array).unwrap_or_else(|| panic!("{at}.items: expected an array"));
    let items = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let at = format!("{at}.items[{i}]");
            let pred = members(
                members(item, &at, &["pred"]).get("pred").unwrap_or_else(|| panic!("{at}: expected pred")),
                &format!("{at}.pred"),
                &["conn", "column", "op", "p", "ps", "sub"],
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
    ir::Group { conn: object.get("conn").map(|_| string(object, at, "conn")).unwrap_or_default(), items }
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
                items.as_array().unwrap_or_else(|| panic!("{at}.{key}: expected an array")).iter().enumerate().map(|(i, item)| (format!("{at}.{key}[{i}]"), item)).collect()
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
    let object = members(input, at, &["ir_version", "kind", "entity", "n_params", "limit", "order", "where", "joins", "relations"]);
    let mut query_input = input.clone();
    for key in ["ir_version", "kind", "n_params"] {
        query_input.as_object_mut().expect("input object").remove(key);
    }
    let request = ir::Request {
        ir_version: count(object.get("ir_version"), "input.ir_version"),
        manifest_hash: manifest_hash.to_owned(),
        kind: string(object, at, "kind"),
        query: query(&query_input, at),
        n_params: index(object.get("n_params").unwrap_or_else(|| panic!("input.n_params: expected a count")), "input.n_params"),
        ..Default::default()
    };
    let mut with_hash = input.clone();
    with_hash["manifest_hash"] = json!(manifest_hash);
    assert_eq!(serde_json::to_value(&request).expect("serialized request"), with_hash, "the request read from the fixture differs from its input");
    request
}

fn run(id: &str) {
    let clock = CaseClock::start();
    orm_testcase::step(format_args!("start {id}"));
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
                        let params: Vec<i64> = step.bind_slots.iter().map(|slot| if slot.from == "parent" { -1 } else { slot.param as i64 }).collect();
                        json!({"role": step.role, "sql": step.sql, "params": params, "tables": step.tables})
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
    assert!(cpu < CPU_LIMIT, "{id}: used {cpu:?} of CPU time, limit {CPU_LIMIT:?}");
    orm_testcase::step(format_args!("{id} cpu={cpu:?} wall={:?}", clock.wall()));
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_statement() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    run("planner_statement");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_count() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    run("planner_count");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_rejects_unknown_column() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    run("planner_rejects_unknown_column");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_restore() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    run("planner_restore");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_restore_rejects_non_key() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    run("planner_restore_rejects_non_key");
}

#[test]
#[ignore = "run by feature-check"]
fn coverage_planner_tables() {
    let _case = orm_testcase::case!(orm_testcase::COMPUTE);
    run("planner_tables");
}
