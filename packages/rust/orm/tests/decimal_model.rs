use polyspec_orm::decimal::normalize;
use polyspec_orm::serde_json::Value;
use polyspec_orm_testcase::Trial;

/// Each case of contracts/fixtures/decimal_model.json is the trial `decimal_model_fixture::<id>`.
fn decimal_model_fixture() -> Vec<Trial> {
    let fixture: Value = polyspec_orm::serde_json::from_str(include_str!("../../../../contracts/fixtures/decimal_model.json")).unwrap();
    let columns = fixture["columns"].as_array().unwrap().clone();
    fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| {
            let (case, columns) = (case.clone(), columns.clone());
            let id = case["id"].as_str().unwrap().to_owned();
            polyspec_orm_testcase::trial(format!("decimal_model_fixture::{id}"), polyspec_orm_testcase::COMPUTE, move || decimal_model_case(&case, &columns))
        })
        .collect()
}

fn decimal_model_case(case: &Value, columns: &[Value]) {
    let column = columns.iter().find(|column| column["id"] == case["column"]).unwrap();
    let input = case["input"].as_str().unwrap();
    let actual = normalize(input, column["precision"].as_u64().unwrap() as u8, column["scale"].as_u64().unwrap() as u8);
    if let Some(expected) = case["expected"]["value"].as_str() {
        assert_eq!(actual.unwrap(), expected, "{}", case["id"]);
    } else {
        assert_eq!(actual.unwrap_err().code(), case["expected"]["error"].as_str().unwrap(), "{}", case["id"]);
    }
}

fn main() {
    polyspec_orm_testcase::run(decimal_model_fixture());
}
