use orm_schema::physical_graph::PhysicalGraph;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
#[test]
fn physical_graph_limits() {
    let started = Instant::now();
    println!("RUN physical_graph_limits");
    let fixture: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_graphs.json")).unwrap();
    let cases = fixture["limits"].as_array().unwrap();
    assert_eq!(cases.len(), 5);
    for limit in cases {
        let comment = "x".repeat(limit["commentBytes"].as_u64().unwrap() as usize);
        let tables = (0..limit["tables"].as_u64().unwrap())
            .map(|i| {
                let mut table = fixture["base"]["tables"][0].clone();
                table["id"] = json!(format!("t-{i}"));
                table["identity"] = json!([null, "main", format!("Table.{i}"), null]);
                table["columns"] = Value::Array(
                    (0..limit["columns"].as_u64().unwrap())
                        .map(|j| {
                            let mut column = fixture["base"]["tables"][0]["columns"][0].clone();
                            column["id"] = json!(format!("c-{i}-{j}"));
                            column["name"] = json!(format!("Column.{j}"));
                            column["comment"] = json!(comment);
                            column
                        })
                        .collect(),
                );
                table
            })
            .collect::<Vec<_>>();
        let fks = vec![fixture["base"]["foreignKeys"][0].clone(); limit["foreignKeys"].as_u64().unwrap_or(0) as usize];
        let mut value = fixture["base"].clone();
        value["tables"] = Value::Array(tables);
        value["foreignKeys"] = Value::Array(fks);
        let error = PhysicalGraph::from_value(value).unwrap_err();
        assert_eq!(error.path(), limit["error"].as_str().unwrap(), "{}", limit["id"]);
        assert_eq!(error.to_string(), "SCHEMA_INVALID");
        println!("PASS physical_graph_limit {}", limit["id"]);
    }
    assert!(started.elapsed() < Duration::from_secs(15));
    println!("PASS physical_graph_limits {:?}", started.elapsed());
}
