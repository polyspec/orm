use orm_schema::physical_index::PhysicalIndex;
use serde_json::Value;

fn input(base: &Value, case: &Value) -> Value {
    let mut value = base.clone();
    let unit = case["unit"].as_str().unwrap_or("x");
    if let Some(changes) = case["changes"].as_object() {
        for (k, v) in changes {
            value[k] = v.clone();
        }
    }
    if let Some(changes) = case["termChanges"].as_object() {
        for (k, v) in changes {
            value["terms"][0][k] = v.clone();
        }
    }
    if let Some(field) = case["drop"].as_str() {
        value.as_object_mut().unwrap().remove(field);
    }
    if let Some(field) = case["field"].as_str() {
        value[field] = Value::String(unit.repeat(case["count"].as_u64().unwrap() as usize));
    }
    if let Some(field) = case["termField"].as_str() {
        value["terms"][0][field] = Value::String(unit.repeat(case["count"].as_u64().unwrap() as usize));
    }
    if let Some(size) = case["expression"].as_u64() {
        value["terms"][0]["source"] = serde_json::json!({"kind":"expression","sql":"x".repeat(size as usize)});
    }
    if let Some(count) = case["terms"].as_u64() {
        value["terms"] = Value::Array(vec![value["terms"][0].clone(); count as usize]);
    }
    if let Some(count) = case["include"].as_u64() {
        value["include"] = serde_json::json!((0..count).map(|i| format!("included-{i}")).collect::<Vec<_>>());
    }
    if let Some(count) = case["options"].as_u64() {
        value["options"] = Value::Array(vec![serde_json::json!({"name":"x","value":"x".repeat(case["size"].as_u64().unwrap() as usize)}); count as usize]);
    }
    value
}

#[test]
fn shared_physical_index_vectors() {
    let started = std::time::Instant::now();
    println!("RUN physical_index");
    let fixture: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_indices.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    let bounds = fixture["bounds"].as_array().unwrap();
    assert_eq!(cases.len(), 46);
    assert_eq!(bounds.len(), 20);
    let mut seen = std::collections::BTreeSet::new();
    for case in cases.iter().chain(bounds.iter()) {
        let case_started = std::time::Instant::now();
        let id = case["id"].as_str().unwrap();
        assert!(!id.is_empty() && seen.insert(id));
        println!("RUN {id}");
        let mut value = input(&fixture["base"], case);
        let result = PhysicalIndex::from_value(value.clone());
        if let Some(expected) = case["error"].as_str() {
            assert_eq!(result.unwrap_err().to_string(), expected);
        } else {
            let index = result.unwrap();
            assert_eq!(index.value(), &value);
            value["terms"][0]["source"]["kind"] = Value::String("changed".into());
            assert_ne!(index.value()["terms"][0]["source"]["kind"], value["terms"][0]["source"]["kind"]);
            assert_eq!(format!("{index:?}"), "PhysicalIndex");
        }
        assert!(case_started.elapsed() < std::time::Duration::from_secs(1));
        println!("PASS {id} {:?}", case_started.elapsed());
    }
    assert!(serde_json::from_slice::<Value>(b"\"\xff\"").is_err());
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    println!("PASS physical_index 46 vectors 20 bounds {:?}", started.elapsed());
}
