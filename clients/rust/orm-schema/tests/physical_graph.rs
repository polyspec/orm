use orm_schema::physical_graph::PhysicalGraph;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
#[path = "common/physical_graph_records.rs"]
mod records;

#[test]
fn physical_graph_vectors() {
    let started = Instant::now();
    println!("RUN physical_graph");
    let fixture: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_graphs.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 28);
    let mut seen = std::collections::HashSet::new();
    for case in cases {
        let id = case["id"].as_str().unwrap();
        assert!(!id.is_empty() && seen.insert(id));
        let mut value = fixture["base"].clone();
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
        let result = PhysicalGraph::from_value(value.clone());
        if let Some(path) = case.get("error") {
            let error = result.unwrap_err();
            assert_eq!(error.to_string(), "SCHEMA_INVALID", "{id}");
            assert_eq!(error.path(), path.as_str().unwrap(), "{id}");
            continue;
        }
        let graph = result.unwrap();
        assert_eq!(graph.value(), &value, "{id}");
        value["dialectVersion"] = json!("changed");
        assert_ne!(graph.value()["dialectVersion"], value["dialectVersion"]);
    }
    assert_eq!(fixture["scale"], json!({"tables":2000,"columnsPerTable":30,"foreignKeys":10000}));
    let scale_started = Instant::now();
    let mut tables = Vec::with_capacity(2000);
    for i in 0..2000 {
        let mut table = fixture["base"]["tables"][0].clone();
        table["id"] = json!(format!("t-{i}"));
        table["identity"] = json!([null, "main", format!("Table.{i}"), null]);
        let columns = (0..30)
            .map(|j| {
                let mut column = fixture["base"]["tables"][0]["columns"][0].clone();
                column["id"] = json!(format!("c-{i}-{j}"));
                column["name"] = json!(format!("Column.{j}"));
                column
            })
            .collect::<Vec<_>>();
        table["columns"] = json!(columns);
        tables.push(table);
    }
    let fks = (0..10000)
        .map(|i| {
            let source = i / 5;
            let target = (source + i % 5) % 2000;
            let mut fk = fixture["base"]["foreignKeys"][0].clone();
            fk["id"] = json!(format!("fk-{i}"));
            fk["name"] = json!(format!("FK.{}", i % 5));
            fk["tableId"] = json!(format!("t-{source}"));
            fk["columns"] = json!([format!("c-{source}-0"), format!("c-{source}-1")]);
            fk["target"] = json!({"tableId":format!("t-{target}"),"columns":[format!("c-{target}-1"),format!("c-{target}-0")]});
            fk
        })
        .collect::<Vec<_>>();
    let mut value = fixture["base"].clone();
    value["tables"] = json!(tables);
    value["foreignKeys"] = json!(fks);
    let records = records::scale(&records::fixture()["base"], 2000);
    for field in ["indices", "keys", "checks"] {
        value[field] = records[field].clone();
    }
    let generated = Instant::now();
    let graph = PhysicalGraph::from_value(value).unwrap();
    let validated = Instant::now();
    for field in ["indices", "keys", "checks"] {
        assert_eq!(graph.value()[field], records[field]);
        assert_eq!(graph.value()[field].as_array().unwrap().len(), 2000);
    }
    assert_eq!(graph.value()["tables"].as_array().unwrap().len(), 2000);
    assert_eq!(graph.value()["tables"].as_array().unwrap().iter().map(|t| t["columns"].as_array().unwrap().len()).sum::<usize>(), 60000);
    assert_eq!(graph.value()["foreignKeys"].as_array().unwrap().len(), 10000);
    for i in 0..10000 {
        assert_eq!(graph.value()["foreignKeys"][i]["id"], format!("fk-{i}"));
        let target = (i / 5 + i % 5) % 2000;
        assert_eq!(graph.value()["foreignKeys"][i]["target"]["columns"][0], format!("c-{target}-1"));
    }
    let json_started = Instant::now();
    let text = graph.to_json().unwrap();
    let parsed = PhysicalGraph::from_json(text.as_bytes()).unwrap();
    assert_eq!(parsed.value(), graph.value());
    assert_eq!(parsed.to_json().unwrap(), text);
    println!("PASS physical_json_retention bytes={} elapsed={:?}", text.len(), json_started.elapsed());
    println!(
        "PASS physical_graph_retention tables=2000 columns=60000 foreignKeys=10000 indices=2000 keys=2000 checks=2000 generate={:?} validate={:?} elapsed={:?}",
        generated.duration_since(scale_started),
        validated.duration_since(generated),
        scale_started.elapsed()
    );
    assert!(started.elapsed() < Duration::from_secs(15));
    println!("PASS physical_graph 28 vectors {:?}", started.elapsed());
}
