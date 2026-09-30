use orm_schema::physical::PhysicalIdentity;
use serde_json::Value;

#[test]
fn shared_physical_identity_vectors_preserve_exact_names() {
    let started = std::time::Instant::now();
    println!("RUN physical_identity");
    let cases: Vec<Value> = serde_json::from_str(include_str!("../../../../contracts/fixtures/physical_identities.json")).unwrap();
    assert_eq!(cases.len(), 10);
    let mut seen = std::collections::BTreeSet::new();
    for case in cases {
        let id = case["id"].as_str().unwrap();
        assert!(!id.is_empty() && seen.insert(id.to_owned()));
        let parts = case["parts"].as_array().unwrap();
        let optional = |i: usize| parts[i].as_str().map(str::to_owned);
        let result = PhysicalIdentity::new(optional(0), optional(1), parts[2].as_str().unwrap().into(), optional(3));
        if case["error"].is_string() {
            assert_eq!(result.unwrap_err().to_string(), "SCHEMA_INVALID");
            continue;
        }
        let identity = result.unwrap();
        assert_eq!(identity.key(), case["key"].as_str().unwrap());
        for (actual, expected) in identity.parts().iter().zip(parts) {
            assert_eq!(*actual, expected.as_str());
        }
    }
    assert!(PhysicalIdentity::new(None, None, "x".repeat(1024), None).is_ok());
    assert!(PhysicalIdentity::new(None, None, "x".repeat(1025), None).is_err());
    assert!(PhysicalIdentity::new(None, None, "한".repeat(342), None).is_err());
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    println!("PASS physical_identity 10 vectors {:?}", started.elapsed());
}
