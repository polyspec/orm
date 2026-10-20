//! The IR request of a shared fixture case, read from its JSON: the planner coverage (coverage_planner.rs, a unit test
//! module of the engine) and the shared validation vectors (tests/ir_validate.rs) build their requests with it.

use crate::ir;
use crate::schema::Manifest;
use serde_json::{json, Map, Value};
use std::path::PathBuf;

pub(crate) fn repository() -> PathBuf {
    polyspec_orm_testcase::manifest_dir().join("../../..")
}

/// The manifest of the dbspec document at the repository path `at`.
pub(crate) fn schema(at: &str) -> Manifest {
    let path = repository().join(at);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let document =
        crate::dbspec::parse(&text, &Default::default()).map(|parsed| parsed.document).unwrap_or_else(|errors| panic!("{}: {errors:?}", path.display()));
    let set = crate::dbspec::manifest(&[&document]).unwrap_or_else(|errors| panic!("{}: {errors:?}", path.display()));
    Manifest::load(&set.manifest_text, &set.manifest_hash).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Finds one `id` case in the fixture and returns its schema document path, input, and expected.
/// An object whose members are all the same kind, such as the `sub` map of `columns`: its member names are free.
fn members_of<'a>(value: &'a Value, at: &str) -> &'a Map<String, Value> {
    value.as_object().unwrap_or_else(|| panic!("{REJECTED}{at}: expected an object, got {value}"))
}

/// Reads the members of `value`. A member outside `allowed` is rejected along with its position.
pub(crate) fn members<'a>(value: &'a Value, at: &str, allowed: &[&str]) -> &'a Map<String, Value> {
    let object = value.as_object().unwrap_or_else(|| panic!("{REJECTED}{at}: expected an object, got {value}"));
    for key in object.keys() {
        assert!(allowed.contains(&key.as_str()), "{REJECTED}{at}.{key}: unsupported request member");
    }
    object
}

fn string(object: &Map<String, Value>, at: &str, key: &str) -> String {
    object.get(key).and_then(Value::as_str).unwrap_or_else(|| panic!("{REJECTED}{at}.{key}: expected a string")).to_owned()
}

/// A panic after `REJECTED` is a request shape that Rust's typed request cannot hold: an unknown member, a member of
/// the wrong type, or a missing required member. As a client that decodes JSON refuses such a request with IR_INVALID
/// (docs/spec/protocol.md), the typed request cannot be built from it.
pub(crate) const REJECTED: &str = "IR_INVALID: ";

/// A text member. A non-string value cannot be held by a typed request.
fn text(object: &Map<String, Value>, at: &str, key: &str) -> String {
    match object.get(key) {
        Some(Value::String(s)) => s.clone(),
        other => panic!("{REJECTED}{at}.{key} is {other:?}, not a string"),
    }
}

/// A string list member, empty if absent.
fn strings(object: &Map<String, Value>, at: &str, key: &str) -> Vec<String> {
    object
        .get(key)
        .map(|list| {
            list.as_array()
                .unwrap_or_else(|| panic!("{REJECTED}{at}.{key}: expected an array"))
                .iter()
                .map(|s| s.as_str().unwrap_or_else(|| panic!("{REJECTED}{at}.{key}: expected strings")).to_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// Makes the input match the values that typed-request serialization omits or fills: an empty `conn` and an empty `key_by` are the same as absent,
/// and a missing or null `ref.path` is "", the root.
fn normalized(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut out = Map::new();
            for (key, member) in object {
                if (key == "conn" || key == "key_by") && member == "" {
                    continue;
                }
                let mut member = normalized(member);
                if key == "ref" {
                    if let Value::Object(r) = &mut member {
                        if r.get("path").is_none_or(Value::is_null) {
                            r.insert("path".into(), json!(""));
                        }
                    }
                }
                out.insert(key.clone(), member);
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(normalized).collect()),
        other => other.clone(),
    }
}

fn index(value: &Value, at: &str) -> usize {
    value.as_u64().and_then(|n| usize::try_from(n).ok()).unwrap_or_else(|| panic!("{REJECTED}{at}: expected a parameter index, got {value}"))
}

fn count(value: Option<&Value>, at: &str) -> u32 {
    value.and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).unwrap_or_else(|| panic!("{REJECTED}{at}: expected a count"))
}

/// Reads one column function or value function as IR.
fn func(value: &Value, at: &str) -> ir::Func {
    let object = members(value, at, &["name", "ps"]);
    ir::Func { name: string(object, at, "name"), ps: indexes(object, at, "ps") }
}

/// The list of parameter numbers of `key`, empty if absent.
fn indexes(object: &Map<String, Value>, at: &str, key: &str) -> Vec<usize> {
    object
        .get(key)
        .map(|ps| ps.as_array().unwrap_or_else(|| panic!("{REJECTED}{at}.{key}: expected an array")).iter().map(|p| index(p, &format!("{at}.{key}"))).collect())
        .unwrap_or_default()
}

/// Reads the assignment list of a write as IR.
fn assigns(value: &Value, at: &str) -> Vec<ir::Assign> {
    value
        .as_array()
        .unwrap_or_else(|| panic!("{REJECTED}{at}: expected an array"))
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let at = format!("{at}[{i}]");
            let a = members(a, &at, &["column", "p", "null", "plus_p", "minus_p"]);
            ir::Assign {
                column: string(a, &at, "column"),
                p: a.get("p").map(|p| index(p, &format!("{at}.p"))),
                null: a.get("null").map(|n| n.as_bool().unwrap_or_else(|| panic!("{REJECTED}{at}.null: expected a boolean"))).unwrap_or(false),
                plus_p: a.get("plus_p").map(|p| index(p, &format!("{at}.plus_p"))),
                minus_p: a.get("minus_p").map(|p| index(p, &format!("{at}.minus_p"))),
            }
        })
        .collect()
}

fn group(value: &Value, at: &str) -> ir::Group {
    let object = members(value, at, &["conn", "not", "items"]);
    let items = object.get("items").and_then(Value::as_array).unwrap_or_else(|| panic!("{REJECTED}{at}.items: expected an array"));
    let items = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let at = format!("{at}.items[{i}]");
            if let Some(nested) = members(item, &at, &["pred", "group", "joined"]).get("group") {
                return ir::Item::Group { group: group(nested, &format!("{at}.group")) };
            }
            if let Some(joined) = members(item, &at, &["pred", "group", "joined"]).get("joined") {
                let at = format!("{at}.joined");
                let joined = members(joined, &at, &["conn", "join"]);
                return ir::Item::Joined {
                    joined: ir::JoinedRef {
                        conn: joined.get("conn").map(|_| string(joined, &at, "conn")).unwrap_or_default(),
                        join: string(joined, &at, "join"),
                    },
                };
            }
            let pred = members(
                members(item, &at, &["pred", "group", "joined"]).get("pred").unwrap_or_else(|| panic!("{REJECTED}{at}: expected pred")),
                &format!("{at}.pred"),
                &["conn", "column", "op", "p", "ps", "sub", "fn", "value", "ref"],
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
                        .map(|ps| {
                            ps.as_array()
                                .unwrap_or_else(|| panic!("{REJECTED}{at}.ps: expected an array"))
                                .iter()
                                .map(|p| index(p, &format!("{at}.ps")))
                                .collect()
                        })
                        .unwrap_or_default(),
                    r#fn: pred.get("fn").map(|f| func(f, &format!("{at}.fn"))),
                    value: pred.get("value").map(|f| func(f, &format!("{at}.value"))),
                    r#ref: pred.get("ref").map(|r| {
                        let at = format!("{at}.ref");
                        let object = members(r, &at, &["path", "column"]);
                        // A missing or null path is the root.
                        let path = match object.get("path") {
                            None | Some(Value::Null) => String::new(),
                            Some(_) => text(object, &at, "path"),
                        };
                        ir::ColRef { path, column: text(object, &at, "column") }
                    }),
                    sub: pred.get("sub").map(|sub| {
                        let at = format!("{at}.sub");
                        let object = members(sub, &at, &["query", "column", "agg"]);
                        ir::Sub {
                            query: Box::new(query(
                                object.get("query").unwrap_or_else(|| panic!("{REJECTED}{at}.query: expected a query")),
                                &format!("{at}.query"),
                            )),
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
        not: object.get("not").map(|n| n.as_bool().unwrap_or_else(|| panic!("{REJECTED}{at}.not: expected a boolean"))).unwrap_or(false),
        items,
    }
}

/// Reads one query as IR: entity, where, join, relation, order, limit.
fn query(value: &Value, at: &str) -> ir::Query {
    let object = members(
        value,
        at,
        &["entity", "columns", "on", "where", "joins", "relations", "order", "group_by", "limit", "key_by", "limit_per_parent", "if_parent"],
    );
    let columns = object.get("columns").map(|c| {
        let at = format!("{at}.columns");
        let c = members(c, &at, &["mode", "add", "remove", "fn", "sub"]);
        ir::Columns {
            mode: c.get("mode").map(|_| string(c, &at, "mode")).unwrap_or_default(),
            add: strings(c, &at, "add"),
            remove: strings(c, &at, "remove"),
            sub: c
                .get("sub")
                .map(|subs| {
                    let at = format!("{at}.sub");
                    members_of(subs, &at)
                        .iter()
                        .map(|(name, sub)| {
                            let at = format!("{at}.{name}");
                            let object = members(sub, &at, &["query", "column", "agg"]);
                            let sub = ir::Sub {
                                query: Box::new(query(
                                    object.get("query").unwrap_or_else(|| panic!("{REJECTED}{at}.query: expected a query")),
                                    &format!("{at}.query"),
                                )),
                                column: object.get("column").map(|_| string(object, &at, "column")).unwrap_or_default(),
                                agg: object.get("agg").map(|_| string(object, &at, "agg")).unwrap_or_default(),
                            };
                            (name.clone(), sub)
                        })
                        .collect()
                })
                .unwrap_or_default(),
            r#fn: c
                .get("fn")
                .map(|fns| {
                    let at = format!("{at}.fn");
                    members_of(fns, &at)
                        .iter()
                        .map(|(name, cf)| {
                            let at = format!("{at}.{name}");
                            let object = members(cf, &at, &["column", "fn"]);
                            let f = object.get("fn").unwrap_or_else(|| panic!("{REJECTED}{at}.fn: expected a function"));
                            (name.clone(), ir::ColFunc { column: string(object, &at, "column"), r#fn: func(f, &format!("{at}.fn")) })
                        })
                        .collect()
                })
                .unwrap_or_default(),
        }
    });
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
                    .unwrap_or_else(|| panic!("{REJECTED}{at}.{key}: expected an array"))
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
            let o = members(o, &at, &["column", "desc", "random", "fn"]);
            ir::Order {
                column: if o.contains_key("column") { string(o, &at, "column") } else { String::new() },
                desc: o.get("desc").map(|d| d.as_bool().unwrap_or_else(|| panic!("{REJECTED}{at}.desc: expected a boolean"))).unwrap_or(false),
                random: o.get("random").map(|r| r.as_bool().unwrap_or_else(|| panic!("{REJECTED}{at}.random: expected a boolean"))).unwrap_or(false),
                r#fn: o.get("fn").map(|f| func(f, &format!("{at}.fn"))),
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
                query: Box::new(query(j.get("query").unwrap_or_else(|| panic!("{REJECTED}{at}.query: expected a query")), &format!("{at}.query"))),
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
                .unwrap_or_else(|| panic!("{REJECTED}{at}.keys: expected an array"))
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
                query: Box::new(query(r.get("query").unwrap_or_else(|| panic!("{REJECTED}{at}.query: expected a query")), &format!("{at}.query"))),
            }
        })
        .collect();
    ir::Query {
        entity: string(object, at, "entity"),
        columns,
        group_by: strings(object, at, "group_by"),
        on: object.get("on").map(|g| group(g, &format!("{at}.on"))),
        where_: object.get("where").map(|w| group(w, &format!("{at}.where"))),
        joins,
        relations,
        order,
        limit,
        key_by: object.get("key_by").map(|_| string(object, at, "key_by")).unwrap_or_default(),
        limit_per_parent: object.get("limit_per_parent").map(|n| count(Some(n), &format!("{at}.limit_per_parent"))).unwrap_or_default(),
        if_parent: object.get("if_parent").map(|v| {
            let at = format!("{at}.if_parent");
            let o = members(v, &at, &["column", "p"]);
            ir::IfParent {
                column: string(o, &at, "column"),
                p: index(o.get("p").unwrap_or_else(|| panic!("{REJECTED}{at}.p: expected an index")), &format!("{at}.p")),
            }
        }),
        ..Default::default()
    }
}

/// Reads the fixture's request as IR. Unsupported members are rejected, and the IR read is serialized again
/// and must equal the input with the manifest hash added.
pub(crate) fn request(input: &Value, manifest_hash: &str) -> ir::Request {
    let at = "input";
    let object = members(
        input,
        at,
        &[
            "ir_version",
            "kind",
            "entity",
            "n_params",
            "columns",
            "limit",
            "order",
            "group_by",
            "where",
            "joins",
            "relations",
            "key_by",
            "set",
            "on_duplicate",
            "optimistic",
            "agg",
        ],
    );
    let mut query_input = input.clone();
    for key in ["ir_version", "kind", "n_params", "set", "on_duplicate", "optimistic", "agg"] {
        query_input.as_object_mut().expect("input object").remove(key);
    }
    let request = ir::Request {
        ir_version: count(object.get("ir_version"), "input.ir_version"),
        manifest_hash: manifest_hash.to_owned(),
        kind: string(object, at, "kind"),
        query: query(&query_input, at),
        n_params: index(object.get("n_params").unwrap_or_else(|| panic!("{REJECTED}input.n_params: expected a count")), "input.n_params"),
        set: object.get("set").map(|set| assigns(set, "input.set")).unwrap_or_default(),
        on_duplicate: object.get("on_duplicate").map(|set| assigns(set, "input.on_duplicate")).unwrap_or_default(),
        agg: object.get("agg").map(|_| string(object, at, "agg")).unwrap_or_default(),
        optimistic: object.get("optimistic").map(|o| {
            let o = members(o, "input.optimistic", &["column", "p"]);
            ir::Optimist {
                column: string(o, "input.optimistic", "column"),
                p: index(o.get("p").unwrap_or_else(|| panic!("{REJECTED}input.optimistic.p: expected a parameter index")), "input.optimistic.p"),
            }
        }),
        ..Default::default()
    };
    let mut with_hash = normalized(input);
    with_hash["manifest_hash"] = json!(manifest_hash);
    assert_eq!(serde_json::to_value(&request).expect("serialized request"), with_hash, "the request read from the fixture differs from its input");
    request
}
