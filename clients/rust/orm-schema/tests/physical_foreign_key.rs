use orm_schema::physical_foreign_key::PhysicalForeignKey;
use serde_json::Value;
#[test]
fn shared_physical_foreign_key_vectors_preserve_order_and_actions() {
    let started = std::time::Instant::now();
    println!("RUN physical_foreign_key");
    let fixture: Value = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_foreign_keys.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 26);
    let mut seen = std::collections::BTreeSet::new();
    for case in cases {
        let id = case["id"].as_str().unwrap();
        assert!(!id.is_empty() && seen.insert(id));
        let mut value = fixture["base"].clone();
        for (key, change) in case["changes"].as_object().unwrap() {
            value[key] = change.clone();
        }
        let result = PhysicalForeignKey::from_value(value.clone());
        if case["error"].is_string() {
            assert_eq!(result.unwrap_err().to_string(), "SCHEMA_INVALID");
            continue;
        }
        let fk = result.unwrap();
        assert_eq!(fk.value(), &value);
        value["target"]["tableId"] = Value::String("changed".into());
        assert_ne!(fk.value()["target"]["tableId"], value["target"]["tableId"]);
    }
    let mut bounded = fixture["base"].clone();
    let ids: Vec<String> = (0..64).map(|index| format!("column-{index}")).collect();
    bounded["columns"] = serde_json::json!(ids);
    bounded["target"]["columns"] = bounded["columns"].clone();
    assert!(PhysicalForeignKey::from_value(bounded.clone()).is_ok());
    bounded["columns"].as_array_mut().unwrap().push(Value::String("column-64".into()));
    bounded["target"]["columns"] = bounded["columns"].clone();
    assert!(PhysicalForeignKey::from_value(bounded).is_err());
    let scale_started = std::time::Instant::now();
    let mut retained = Vec::with_capacity(2000);
    for index in 0..2000 {
        let mut value = fixture["base"].clone();
        value["id"] = Value::String(format!("fk-{index}"));
        value["name"] = Value::String(format!("FK.{index}"));
        retained.push(PhysicalForeignKey::from_value(value).unwrap());
    }
    for (index, fk) in retained.iter().enumerate() {
        assert_eq!(fk.value()["id"], format!("fk-{index}"));
    }
    println!("PASS physical_fk_retention records={} elapsed={:?}", retained.len(), scale_started.elapsed());
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    println!("PASS physical_foreign_key 26 vectors {:?}", started.elapsed());
}
