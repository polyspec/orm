use orm_schema::physical_check::PhysicalCheck;
use serde_json::Value;

#[test]
fn shared_physical_check_vectors() {
    let started = std::time::Instant::now();
    println!("RUN physical_check");
    let fixture: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_checks.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 24);
    let mut seen = std::collections::BTreeSet::new();
    for case in cases {
        let id = case["id"].as_str().unwrap();
        assert!(!id.is_empty() && seen.insert(id));
        let mut value = fixture["base"].clone();
        for (key, change) in case["changes"].as_object().unwrap() {
            value[key] = change.clone();
        }
        let result = PhysicalCheck::from_value(value.clone());
        if case["error"].is_string() {
            assert_eq!(result.unwrap_err().to_string(), "SCHEMA_INVALID");
            continue;
        }
        let record = result.unwrap();
        assert_eq!(record.value(), &value);
        value["expressionSql"] = Value::String("changed".into());
        assert_ne!(record.value()["expressionSql"], value["expressionSql"]);
    }
    let bounds = fixture["bounds"].as_array().unwrap();
    assert_eq!(bounds.len(), 17);
    let mut seen = std::collections::BTreeSet::new();
    for case in bounds {
        let id = case["id"].as_str().unwrap();
        assert!(!id.is_empty() && seen.insert(id));
        let mut value = fixture["base"].clone();
        if let Some(field) = case["field"].as_str() {
            value[field] = Value::String(case["unit"].as_str().unwrap().repeat(case["count"].as_u64().unwrap() as usize));
        }
        if let Some(count) = case["options"].as_u64() {
            value["options"] =
                Value::Array((0..count).map(|_| serde_json::json!({"name":"x","value":"x".repeat(case["size"].as_u64().unwrap() as usize)})).collect());
        }
        if let Some(field) = case["drop"].as_str() {
            value.as_object_mut().unwrap().remove(field);
        }
        let result = PhysicalCheck::from_value(value.clone());
        if case["error"].is_string() {
            assert_eq!(result.unwrap_err().to_string(), "SCHEMA_INVALID");
        } else {
            assert_eq!(result.unwrap().value(), &value);
        }
    }
    // Rust strings cannot contain invalid UTF-8; the JSON producer rejects it.
    assert!(serde_json::from_slice::<Value>(b"\"\xff\"").is_err());
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    println!("PASS physical_check 24 vectors 17 bounds {:?}", started.elapsed());
}
