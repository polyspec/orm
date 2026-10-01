use orm_schema::physical_graph::PhysicalGraph;
use serde_json::{json, Value};
#[path = "common/case_clock.rs"]
mod case_clock;
#[path = "common/physical_graph_records.rs"]
mod records;
use case_clock::CaseClock;

fn failure(value: Value, path: &str) {
    let error = PhysicalGraph::from_value(value).unwrap_err();
    assert_eq!(error.to_string(), "SCHEMA_INVALID");
    assert_eq!(error.path(), path);
}
#[test]
fn physical_graph_records() {
    let started = CaseClock::start();
    println!("RUN physical_graph_records");
    let fixture = records::fixture();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 35);
    assert_eq!(fixture["duplicates"].as_array().unwrap().len(), 3);
    assert_eq!(fixture["counts"].as_array().unwrap().len(), 3);
    assert_eq!(fixture["bytes"].as_array().unwrap().len(), 3);
    assert_eq!(fixture["scale"], json!({"tables":2000,"indices":2000,"keys":2000,"checks":2000}));
    let mut seen = std::collections::HashSet::new();
    for case in cases {
        let case_started = CaseClock::start();
        let id = case["id"].as_str().unwrap();
        assert!(!id.is_empty() && seen.insert(id));
        println!("RUN {id}");
        let mut value = fixture["base"].clone();
        if let Some(drop) = case["drop"].as_str() {
            value.as_object_mut().unwrap().remove(drop);
        }
        for change in case["changes"].as_array().unwrap() {
            let path = change["path"].as_array().unwrap();
            let mut target = &mut value;
            for key in &path[..path.len() - 1] {
                target = if let Some(key) = key.as_str() { &mut target[key] } else { &mut target[key.as_u64().unwrap() as usize] };
            }
            let key = &path[path.len() - 1];
            if let Some(key) = key.as_str() {
                target[key] = change["value"].clone();
            } else {
                target[key.as_u64().unwrap() as usize] = change["value"].clone();
            }
        }
        if let Some(path) = case.get("error") {
            failure(value, path.as_str().unwrap());
        } else {
            let graph = PhysicalGraph::from_value(value.clone()).unwrap();
            assert_eq!(graph.value(), &value);
            if !value["indices"].as_array().unwrap().is_empty() {
                value["indices"][0]["terms"][0]["order"] = json!("changed");
                assert_ne!(graph.value()["indices"][0]["terms"][0]["order"], value["indices"][0]["terms"][0]["order"]);
            }
        }
        case_started.assert_within(id, std::time::Duration::from_secs(1));
        println!("PASS {id} {:?}", case_started.wall());
    }
    for case in fixture["duplicates"].as_array().unwrap() {
        let mut value = fixture["base"].clone();
        let field = case["field"].as_str().unwrap();
        let mut record = value[field][0].clone();
        record["id"] = json!("another");
        for key in ["name", "kind", "indexId"] {
            if let Some(v) = case.get(key) {
                record[key] = v.clone();
            }
        }
        value[field].as_array_mut().unwrap().push(record);
        failure(value, case["error"].as_str().unwrap());
    }
    for case in fixture["counts"].as_array().unwrap() {
        let mut value = fixture["base"].clone();
        value[case["field"].as_str().unwrap()] = Value::Array(vec![Value::Null; case["count"].as_u64().unwrap() as usize]);
        failure(value, case["error"].as_str().unwrap());
    }
    let mut value = fixture["base"].clone();
    for field in ["foreignKeys", "indices", "keys"] {
        value[field] = Value::Array(vec![Value::Null; 20000]);
    }
    failure(value, "");
    for case in fixture["bytes"].as_array().unwrap() {
        let mut value = fixture["base"].clone();
        let field = case["field"].as_str().unwrap();
        let prototype = value[field][0].clone();
        let comment = "x".repeat(case["commentBytes"].as_u64().unwrap() as usize);
        value[field] = Value::Array(
            (0..case["count"].as_u64().unwrap())
                .map(|i| {
                    let mut record = prototype.clone();
                    record["id"] = json!(format!("record-{i}"));
                    record["name"] = Value::Null;
                    record["comment"] = json!(comment);
                    if field == "keys" {
                        record["kind"] = json!("unique");
                        record["indexId"] = Value::Null;
                    }
                    record
                })
                .collect(),
        );
        if field == "indices" {
            value["keys"] = json!([]);
        }
        failure(value, case["error"].as_str().unwrap());
        println!("PASS {field}-string-budget");
    }
    // Exercise the same declared scale generator used by the connected graph test.
    let scale = records::scale(&fixture["base"], 2);
    assert_eq!(scale["indices"].as_array().unwrap().len(), 2);
    started.assert_within("physical_graph_records", std::time::Duration::from_secs(15));
    println!("PASS physical_graph_records {:?}", started.wall());
}
