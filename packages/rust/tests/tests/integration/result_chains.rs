use super::model::Author;
use polyspec_orm::StyledValue;
use std::sync::{Arc, Mutex};

fn tags() -> polyspec_orm::ordered_json::Value {
    polyspec_orm::ordered_json::Value::array(&[polyspec_orm::ordered_json::Value::string("fixture")]).expect("fixture array")
}

fn mapped() -> Result<Author, std::io::Error> {
    let row = Author::new().set_jsons_tags(StyledValue::Value(tags())).map_err(std::io::Error::other)?;
    Ok(row)
}

fn wrapped() -> Result<Option<Author>, std::io::Error> {
    Author::new().set_jsons_tags(StyledValue::Value(tags())).map_err(std::io::Error::other).map(Some)
}

// Requirements: COD-20, COD-25.
#[test]
fn generated_model_result_chains_preserve_assigned_values() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    for row in [mapped().expect("error mapping"), wrapped().expect("success mapping").expect("model")] {
        let StyledValue::Value(value) = row.get_jsons_tags().expect("assigned field") else {
            panic!("assigned field is SQL NULL");
        };
        assert_eq!(value.compact(), tags().compact());
    }
}

// Requirements: INT-88, INT-89.
#[tokio::test]
async fn generated_terminal_returns_first_builder_error_without_sending_sql() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let fixture = super::temp_sqlite::TempSqlite::create("orm-first-builder-error");
    let db = super::model::connect(&fixture.dsn(), 1, polyspec_orm::Config::default()).await.expect("SQLite connection");
    let statements = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&statements);
    let subscription = db
        .subscribe(move |event: &polyspec_orm::StatementEvent<'_>| {
            recorded.lock().unwrap().push(event.sql.to_owned());
            Ok(())
        })
        .expect("SQLite statement subscriber");

    let error = Author::new()
        .connect(&db)
        .seq(Vec::<i64>::new())
        .name(Vec::<String>::new())
        .get_count()
        .await
        .expect_err("the terminal returns the first invalid builder condition");

    subscription.unsubscribe();
    assert_eq!(error.code(), polyspec_orm::codes::EMPTY_IN);
    assert!(error.to_string().contains("seq received an empty list"), "first builder error: {error}");
    assert_eq!(*statements.lock().unwrap(), Vec::<String>::new(), "the terminal sent no SQL");
    db.close().await;
}
