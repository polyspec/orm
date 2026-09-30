use orm_schema::physical_column::PhysicalColumn;
use serde_json::Value;

#[test]
fn shared_physical_column_vectors_preserve_fields() {
    let started = std::time::Instant::now();
    println!("RUN physical_column");
    let fixture: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_columns.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 25);
    let mut seen = std::collections::BTreeSet::new();
    for case in cases {
        let id = case["id"].as_str().unwrap();
        assert!(!id.is_empty() && seen.insert(id));
        let mut value = fixture["base"].clone();
        for (key, change) in case["changes"].as_object().unwrap() {
            value[key] = change.clone();
        }
        let result = PhysicalColumn::from_value(value.clone());
        if case["error"].is_string() {
            assert_eq!(result.unwrap_err().to_string(), "SCHEMA_INVALID");
            continue;
        }
        let column = result.unwrap();
        assert_eq!(column.value(), &value);
        value["comment"] = Value::String("changed".into());
        assert_ne!(column.value()["comment"], value["comment"]);
    }
    let mut invalid = fixture["base"].clone();
    invalid["typeSql"] = Value::String("x".repeat(4097));
    assert!(PhysicalColumn::from_value(invalid.clone()).is_err());
    invalid["typeSql"] = Value::String("한".repeat(1366));
    assert!(PhysicalColumn::from_value(invalid.clone()).is_err());
    invalid["typeSql"] = fixture["base"]["typeSql"].clone();
    invalid["options"] = serde_json::json!(vec![serde_json::json!({"name":"option","value":"x".repeat(1100)}); 64]);
    assert!(PhysicalColumn::from_value(invalid.clone()).is_err());
    invalid["options"] = serde_json::json!(vec![serde_json::json!({"name":"option","value":""}); 65]);
    assert!(PhysicalColumn::from_value(invalid).is_err());
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    println!("PASS physical_column 25 vectors {:?}", started.elapsed());
}
