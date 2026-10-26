//! Exact in-memory Collection lookup and fetched-value behavior.
use std::collections::HashMap;

polyspec_orm::models!();

use model::Author;
use polyspec_orm::{Collection, Key};

#[test]
fn get_and_fetched_value_use_the_typed_key() {
    // Requirements: INT-80, INT-86.
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let integer_key = Key::I(7);
    let text_key = Key::S("7".into());
    let items: polyspec_orm::model::Boxed =
        vec![(integer_key.clone(), Box::new(Author::new().set_name("integer"))), (text_key.clone(), Box::new(Author::new().set_name("text")))];
    let fetched = HashMap::from([(integer_key, serde_json::json!("integer")), (text_key, serde_json::json!("text"))]);
    let collection = Collection::<Author>::from_boxes(items, fetched);

    assert_eq!(collection.get(7).map(|row| row.get_name().unwrap()), Some("integer"));
    assert_eq!(collection.get("7").map(|row| row.get_name().unwrap()), Some("text"));
    assert!(collection.get(8).is_none());
    assert_eq!(collection.fetched_value(7), Some(&serde_json::json!("integer")));
    assert_eq!(collection.fetched_value("7"), Some(&serde_json::json!("text")));
    assert!(collection.fetched_value(8).is_none());
}
