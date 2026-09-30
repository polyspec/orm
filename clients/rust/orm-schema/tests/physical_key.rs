use orm_schema::physical_key::PhysicalKey;
use serde_json::Value;

fn input(base: &Value, case: &Value) -> Value {
    let mut value = base.clone();
    if let Some(changes) = case["changes"].as_object() {
        for (k, v) in changes {
            value[k] = v.clone();
        }
    }
    if let Some(field) = case["drop"].as_str() {
        value.as_object_mut().unwrap().remove(field);
    }
    if let Some(field) = case["field"].as_str() {
        value[field] = Value::String(case["unit"].as_str().unwrap_or("x").repeat(case["count"].as_u64().unwrap() as usize));
    }
    if let Some(count) = case["columns"].as_u64() {
        value["columns"] = serde_json::json!((0..count).map(|i| format!("column-{i}")).collect::<Vec<_>>());
    }
    if let Some(count) = case["options"].as_u64() {
        value["options"] = Value::Array(vec![serde_json::json!({"name":"x","value":"x".repeat(case["size"].as_u64().unwrap() as usize)}); count as usize]);
    }
    value
}

#[test]
fn shared_physical_key_vectors() {
    let started = std::time::Instant::now();
    println!("RUN physical_key");
    let fixture: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_keys.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    let bounds = fixture["bounds"].as_array().unwrap();
    assert_eq!(cases.len(), 35);
    assert_eq!(bounds.len(), 14);
    let mut seen = std::collections::BTreeSet::new();
    for case in cases.iter().chain(bounds.iter()) {
        let case_started = std::time::Instant::now();
        let id = case["id"].as_str().unwrap();
        assert!(!id.is_empty() && seen.insert(id));
        println!("RUN {id}");
        let mut value = input(&fixture["base"], case);
        let result = PhysicalKey::from_value(value.clone());
        if let Some(expected) = case["error"].as_str() {
            assert_eq!(result.unwrap_err().to_string(), expected);
        } else {
            let key = result.unwrap();
            assert_eq!(key.value(), &value);
            value["columns"][0] = Value::String("changed".into());
            assert_ne!(key.value()["columns"][0], value["columns"][0]);
            assert_eq!(format!("{key:?}"), "PhysicalKey");
        }
        assert!(case_started.elapsed() < std::time::Duration::from_secs(1));
        println!("PASS {id} {:?}", case_started.elapsed());
    }
    assert!(serde_json::from_slice::<Value>(b"\"\xff\"").is_err());
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    println!("PASS physical_key 35 vectors 14 bounds {:?}", started.elapsed());
}
