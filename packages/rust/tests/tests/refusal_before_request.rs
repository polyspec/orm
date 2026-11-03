//! The refusal of the errors vector of tests/conformance/vectors.json before any request (DSL-10, DSL-19, DSL-47, DSL-67,
//! DSL-96, DSL-98, DSL-123, PRT-14): each chain runs on a SQLite file that has no table with a statement subscriber, so a
//! chain that reached the database would fail on the missing table with another code and with an event. Its typed half is
//! the refusal-* cases of packages/rust/testing/compiler-fixtures/cases.json.
use std::sync::{Arc, Mutex};

#[path = "common/temp_sqlite.rs"]
mod temp_sqlite;

polyspec_orm::models!();
use model::{Author, User};

const NAMES: [&str; 9] = [
    "missing connector",
    "dangling connector",
    "empty list",
    "no connection",
    "lock outside a transaction",
    "join child with connection",
    "page with limit",
    "relation with limit",
    "unjoined model placement",
];

fn code_of<T>(result: polyspec_orm::Result<T>) -> Option<String> {
    result.err().map(|error| error.code().to_string())
}

#[tokio::test]
async fn refusal_before_request() {
    // Requirements: DSL-10, DSL-19, DSL-47, DSL-67, DSL-96, DSL-98, DSL-123, PRT-14.
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let path = polyspec_orm_testcase::manifest_dir().join("../../../tests/conformance/vectors.sqlite.json");
    let file: serde_json::Value = serde_json::from_slice(&std::fs::read(path).expect("read the SQLite vectors")).expect("parse the SQLite vectors");
    let vector = file["vectors"].as_array().expect("vectors").iter().find(|v| v["name"] == "errors").expect("the errors vector");
    assert_eq!(vector["chain"], NAMES.join(", "));
    assert_eq!(vector["expect"]["statements"], serde_json::json!([]));
    let fixture = temp_sqlite::TempSqlite::create("polyspec-refusal");
    let config = polyspec_orm::Config { aes_key: "test-aes-key".into(), blind_index_key: "test-blind-key".into(), ..Default::default() };
    let db = model::connect(&fixture.dsn(), 4, config).await.expect("connect");
    let statements = Arc::new(Mutex::new(Vec::<String>::new()));
    let hook = statements.clone();
    let _recording = db
        .subscribe(move |event: &polyspec_orm::StatementEvent<'_>| {
            hook.lock().unwrap().push(event.sql.to_string());
            Ok(())
        })
        .expect("a SQL connection accepts a subscriber");
    let author = || Author::new().connect(&db);
    // A chain that the spec does not refuse reaches the database, so an empty statement list means no request.
    assert!(author().seq(42).gets().await.is_err(), "a chain that is not refused found a table in the empty database");
    assert!(!std::mem::take(&mut *statements.lock().unwrap()).is_empty(), "the subscriber saw no statement of a chain that reached the database");
    let mut observed: Vec<(Option<String>, Vec<String>)> = Vec::new();
    macro_rules! attempt {
        ($chain:expr) => {{
            let code = code_of($chain.await);
            observed.push((code, std::mem::take(&mut *statements.lock().unwrap())));
        }};
    }
    attempt!(author().name("a").is_close(true).gets());
    attempt!(author().name("a").and(()).gets());
    attempt!(author().seq(Vec::<i64>::new()).gets());
    attempt!(Author::new().name("a").gets());
    attempt!(author().for_update().gets());
    attempt!(author().join_user_seq_with_seq(User::new().connect(&db)).gets());
    attempt!(author().limit(0, 1).gets_page(1, 10));
    attempt!(author().relation(User::new().match_user_seq_with_seq().limit(0, 1)).gets_by_seq(42));
    attempt!(author().name("a").or(&User::new()).gets());
    let expected = vector["expect"]["result"].as_array().expect("result");
    assert_eq!(observed.len(), expected.len());
    for ((name, (code, sent)), want) in NAMES.iter().zip(&observed).zip(expected) {
        assert_eq!(code.as_deref(), want.as_str(), "{name}");
        assert!(sent.is_empty(), "{name} sent {sent:?} before its refusal");
    }
}
