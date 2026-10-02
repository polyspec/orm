use orm::decimal::normalize;

#[test]
fn decimal_model_fixture() {
    let fixture: orm::serde_json::Value = orm::serde_json::from_str(include_str!("../../../../contracts/fixtures/decimal_model.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let column = fixture["columns"].as_array().unwrap().iter().find(|column| column["id"] == case["column"]).unwrap();
        let input = case["input"].as_str().unwrap();
        let actual = normalize(input, column["precision"].as_u64().unwrap() as u8, column["scale"].as_u64().unwrap() as u8);
        if let Some(expected) = case["expected"]["value"].as_str() {
            assert_eq!(actual.unwrap(), expected, "{}", case["id"]);
        } else {
            assert_eq!(actual.unwrap_err().code(), case["expected"]["error"].as_str().unwrap(), "{}", case["id"]);
        }
    }
}
