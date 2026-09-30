use serde_json::{json, Value};
pub fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../../../contracts/fixtures/physical_graph_records.json")).unwrap()
}
pub fn scale(base: &Value, count: usize) -> Value {
    let mut indices = Vec::with_capacity(count);
    let mut keys = Vec::with_capacity(count);
    let mut checks = Vec::with_capacity(count);
    for i in 0..count {
        let mut index = base["indices"][0].clone();
        index["id"] = json!(format!("index-{i}"));
        index["tableId"] = json!(format!("t-{i}"));
        index["terms"][0]["source"]["columnId"] = json!(format!("c-{i}-1"));
        index["terms"][1]["source"]["columnId"] = json!(format!("c-{i}-0"));
        let mut key = base["keys"][0].clone();
        key["id"] = json!(format!("key-{i}"));
        key["tableId"] = json!(format!("t-{i}"));
        key["columns"] = json!([format!("c-{i}-1"), format!("c-{i}-0")]);
        key["indexId"] = index["id"].clone();
        let mut check = base["checks"][0].clone();
        check["id"] = json!(format!("check-{i}"));
        check["tableId"] = json!(format!("t-{i}"));
        check["expressionSql"] = json!("\"Column.0\" > 0");
        indices.push(index);
        keys.push(key);
        checks.push(check);
    }
    json!({"indices":indices,"keys":keys,"checks":checks})
}
