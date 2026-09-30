use super::Author;
use orm::StyledValue;

fn tags() -> orm::ordered_json::Value {
    orm::ordered_json::Value::array(&[orm::ordered_json::Value::string("fixture")])
        .expect("fixture array")
}

fn mapped() -> Result<Author, std::io::Error> {
    let row = Author::new().set_jsons_tags(StyledValue::Value(tags()))
        .map_err(std::io::Error::other)?;
    Ok(row)
}

fn wrapped() -> Result<Option<Author>, std::io::Error> {
    Author::new().set_jsons_tags(StyledValue::Value(tags()))
        .map_err(std::io::Error::other).map(Some)
}

#[test]
fn generated_model_result_chains_preserve_assigned_values() {
    for row in [mapped().expect("error mapping"), wrapped().expect("success mapping").expect("model")] {
        let StyledValue::Value(value) = row.get_jsons_tags().expect("assigned field") else {
            panic!("assigned field is SQL NULL");
        };
        assert_eq!(value.compact(), tags().compact());
    }
}
