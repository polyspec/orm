use orm_schema::physical_graph::PhysicalGraph;
use serde_json::Value;
use std::time::Duration;
#[path = "common/case_clock.rs"]
mod case_clock;
use case_clock::CaseClock;
#[test]
fn physical_graph_json() {
    let start = CaseClock::start();
    println!("RUN physical_graph_json");
    let f: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_graph_json.json")).unwrap();
    assert_eq!(f["cases"].as_array().unwrap().len(), 30);
    let fail = |text: &[u8], path: &str| {
        let e = PhysicalGraph::from_json(text).unwrap_err();
        assert_eq!(e.to_string(), "SCHEMA_INVALID");
        assert_eq!(e.path(), path);
    };
    for c in f["cases"].as_array().unwrap() {
        println!("RUN {}", c["id"]);
        let text = c["text"].as_str().unwrap();
        if c["ok"] == true {
            assert_eq!(PhysicalGraph::from_json(text.as_bytes()).unwrap().value(), &f["empty"]);
        } else {
            fail(text.as_bytes(), c["path"].as_str().unwrap());
        }
        println!("PASS {}", c["id"]);
    }
    for (i, v) in f["versions"].as_array().unwrap().iter().enumerate() {
        let text = f["empty"].to_string().replace("\"version\":1", &format!("\"version\":{}", v.as_str().unwrap()));
        if i < 4 {
            assert_eq!(PhysicalGraph::from_json(text.as_bytes()).unwrap().value(), &f["empty"]);
        } else {
            fail(text.as_bytes(), "");
        }
    }
    let mut records: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_graph_records.json")).unwrap();
    let value = &mut records["base"];
    value["tables"][0]["comment"] = Value::String("</script> <!-- --> \" \\ 😺 �".into());
    let graph = PhysicalGraph::from_json(value.to_string().as_bytes()).unwrap();
    let out = graph.to_json().unwrap();
    let again = PhysicalGraph::from_json(out.as_bytes()).unwrap();
    assert_eq!(again.value(), value);
    assert_eq!(again.to_json().unwrap(), out);
    for text in [" ".repeat(33554433), "[".repeat(17) + &"]".repeat(17), "[".to_owned() + &"0,".repeat(3000000) + "0]"] {
        fail(text.as_bytes(), "");
    }
    fail(&[255], "");
    println!("PASS physical_graph_json {:?}", start.wall());
    start.assert_within("physical_graph_json", Duration::from_secs(15));
}
#[test]
fn physical_graph_json_output() {
    let start = CaseClock::start();
    println!("RUN physical_graph_json_output");
    let f: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_graph_json.json")).unwrap();
    let records: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_graph_records.json")).unwrap();
    for count in [f["output"]["acceptedTables"].as_u64().unwrap(), f["output"]["rejectedTables"].as_u64().unwrap()] {
        let mut value = f["empty"].clone();
        let mut tables = Vec::new();
        for i in 0..count {
            let mut table = records["base"]["tables"][0].clone();
            table["id"] = format!("t-{i}").into();
            table["identity"] = serde_json::json!([null, "main", format!("Table.{i}"), null]);
            table["comment"] = f["output"]["commentCharacter"].as_str().unwrap().repeat(f["output"]["commentBytes"].as_u64().unwrap() as usize).into();
            for (j, column) in table["columns"].as_array_mut().unwrap().iter_mut().enumerate() {
                column["id"] = format!("c-{i}-{j}").into();
            }
            tables.push(table);
        }
        value["tables"] = tables.into();
        let graph = PhysicalGraph::from_value(value.clone()).unwrap();
        if count == f["output"]["acceptedTables"].as_u64().unwrap() {
            let text = graph.to_json().unwrap();
            assert!(text.len() <= 33554432);
            assert_eq!(PhysicalGraph::from_json(text.as_bytes()).unwrap().value(), &value);
        } else {
            let e = graph.to_json().unwrap_err();
            assert_eq!(e.path(), "");
            assert_eq!(e.to_string(), "SCHEMA_INVALID");
        }
    }
    println!("PASS physical_graph_json_output {:?}", start.wall());
    start.assert_within("physical_graph_json_output", Duration::from_secs(15));
}
