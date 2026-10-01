use orm_schema::{
    physical_document::{emit, parse},
    physical_graph::PhysicalGraph,
};
use serde_json::Value;
use std::time::Duration;
#[path = "common/case_clock.rs"]
mod case_clock;
use case_clock::CaseClock;
#[test]
fn physical_document() {
    let start = CaseClock::start();
    println!("RUN physical-document");
    let f: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_document.json")).unwrap();
    let records: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_graph_records.json")).unwrap();
    let mut v = records["base"].clone();
    v["tables"][0]["identity"][2] = f["tableName"].clone();
    v["tables"][0]["columns"][0]["name"] = f["columnName"].clone();
    v["tables"][0]["columns"][0]["typeSql"] = f["typeSql"].clone();
    v["tables"][0]["columns"][0]["comment"] = f["columnComment"].clone();
    let mut fk = v["foreignKeys"][0].clone();
    fk["id"] = "fk-2".into();
    fk["name"] = "FK.Second".into();
    v["foreignKeys"].as_array_mut().unwrap().push(fk);
    let graph = PhysicalGraph::from_value(v.clone()).unwrap();
    let text = emit(&graph, f["prefix"].as_str().unwrap(), f["suffix"].as_str().unwrap(), f["newline"].as_str().unwrap()).unwrap();
    let d = parse(text.as_bytes()).unwrap();
    assert_eq!(d.graph.value(), &v);
    assert_eq!(d.prefix, f["prefix"].as_str().unwrap());
    assert_eq!(d.suffix, f["suffix"].as_str().unwrap());
    assert_eq!(emit(&d.graph, &d.prefix, &d.suffix, &d.newline).unwrap(), text);
    assert_eq!(d.diagram.matches(" : ").count(), 2);
    for s in f["displayStrings"].as_array().unwrap() {
        let s = s.as_str().unwrap();
        assert_eq!(orm_schema::physical_document::restore(&orm_schema::physical_document::display(s)), s);
    }
    assert_eq!(f["mutations"].as_array().unwrap().len(), 7);
    for c in f["mutations"].as_array().unwrap() {
        println!("RUN {}", c["id"]);
        let bad = text.replacen(c["from"].as_str().unwrap(), c["to"].as_str().unwrap(), 1);
        assert_ne!(bad, text);
        let e = parse(bad.as_bytes()).unwrap_err();
        assert_eq!(e.to_string(), "SCHEMA_INVALID");
        assert_eq!(e.line(), c["line"].as_u64().unwrap() as usize);
        assert_eq!(e.path(), c["path"].as_str().unwrap_or(""));
        println!("PASS {}", c["id"]);
    }
    assert!(parse(format!("{text}{text}").as_bytes()).is_err());
    for p in ["No newline", "<!--\n"] {
        assert!(emit(&graph, p, "", "\n").is_err());
    }
    for field in ["tables", "foreignKeys", "indices", "keys", "checks"] {
        v[field] = serde_json::json!([]);
    }
    let empty = PhysicalGraph::from_value(v.clone()).unwrap();
    assert_eq!(parse(emit(&empty, "", "", "\n").unwrap().as_bytes()).unwrap().graph.value(), &v);
    println!("PASS physical-document {:?}", start.wall());
    start.assert_within("physical-document", Duration::from_secs(15));
}
