// The request log of a handle (CORE-190): a handle of with_request_log records each request of a model after its
// request hook succeeded and before it is planned, and observed_requests reads the records and empties the log. The
// cases run on a SQLite file of their own.

use crate::ir::{Group, Item, Pred, Request};
use crate::test_support::Scratch;
use crate::value::Param;
use crate::{Config, Connection, Db, Error, Kind, OrmValue, Query, RequestParams, Schema, TransactionOptions};
use binding_core::cancel_pair;

const CLOCK: &str = include_str!("../../../../contracts/fixtures/clock.dbs");
const CLOCK_HASH: &str = "sha256:fab61fb83cfec00c4d7a4d257b610b87c6fdccd49e02a85848a41ba263bc1ffb";

/// A SQLite database with the table of clock.dbs, without a row.
async fn clock_db(scratch: &Scratch) -> (Db, Schema) {
    let schema = Schema::load(CLOCK, "", CLOCK_HASH).expect("clock.dbs loads");
    let db = Db::connect(&format!("sqlite://{}", scratch.join("clock.sqlite").display()), 1, Config::default()).await.expect("connect");
    db.utils().schema().install(&schema).await.expect("install");
    (db, schema)
}

fn events(schema: &Schema, connection: Connection) -> Query {
    let mut query = Query::new(schema, "clock_event").expect("query");
    query.connect(connection);
    query
}

/// Adds the condition `column = value` to the request, joined by `and` to the conditions that it has.
fn add_equal(request: &mut Request, params: &mut RequestParams, column: &str, value: &str) {
    let p = params.add(value);
    let group = request.query.where_.get_or_insert_with(Group::default);
    let conn = if group.items.is_empty() { "" } else { "and" };
    let pred = Pred { conn: conn.to_owned(), column: column.to_owned(), op: "eq".to_owned(), p: Some(p), ..Default::default() };
    group.items.push(Item::Pred { pred: Box::new(pred) });
}

/// The columns of the conditions of the where of a request text, in their order.
fn where_columns(text: &str) -> Vec<String> {
    let request = Request::from_json(text).expect("a recorded text is a request of the form");
    let group = request.query.where_.unwrap_or_default();
    group
        .items
        .iter()
        .map(|item| match item {
            Item::Pred { pred } => pred.column.clone(),
            other => panic!("the where holds {other:?}, which is no condition"),
        })
        .collect()
}

// Requirements: CORE-190, FMS-31. to_json writes the members of the form in their order and leaves out a member that
// holds its default, and from_json reads the text again.
#[test]
fn a_request_is_written_as_the_text_of_its_form() {
    let _case = polyspec_orm_testcase::case!();
    let mut request = Request { ir_version: crate::ir::VERSION, manifest_hash: "h".to_owned(), kind: "one".to_owned(), n_params: 1, ..Default::default() };
    request.query.entity = "note".to_owned();
    let pred = Pred { column: "id".to_owned(), op: "eq".to_owned(), p: Some(0), ..Default::default() };
    request.query.where_ = Some(Group { items: vec![Item::Pred { pred: Box::new(pred) }], ..Default::default() });
    let text = request.to_json();
    assert_eq!(
        text,
        r#"{"ir_version":2,"manifest_hash":"h","kind":"one","entity":"note","where":{"items":[{"pred":{"column":"id","op":"eq","p":0}}]},"n_params":1}"#
    );
    assert_eq!(Request::from_json(&text).expect("the text is a request").to_json(), text);
}

// Requirements: CORE-190. A parameter is given as the kind that the core holds: an integer is int64, a date its
// canonical text and a date-time its canonical text with six fraction digits.
#[test]
fn a_parameter_is_given_as_the_value_that_the_core_holds() {
    let _case = polyspec_orm_testcase::case!();
    let day = chrono::NaiveDate::from_ymd_opt(2026, 1, 2).expect("a date");
    let instant = day.and_hms_micro_opt(3, 4, 5, 123_456).expect("a date-time");
    let given = [
        Param::Null,
        Param::Bool(true),
        Param::I64(7),
        Param::F64(1.5),
        Param::Str("a".to_owned()),
        Param::Bytes(vec![0, 255]),
        Param::Date(day),
        Param::DateTime(instant),
    ];
    let values: Vec<OrmValue> = given.iter().map(OrmValue::of_param).collect();
    assert_eq!(
        values,
        [
            OrmValue::Null,
            OrmValue::Bool(true),
            OrmValue::Int64(7),
            OrmValue::Float(1.5),
            OrmValue::Text("a".to_owned()),
            OrmValue::Bytes(vec![0, 255]),
            OrmValue::Text("2026-01-02".to_owned()),
            OrmValue::Text("2026-01-02 03:04:05.123456".to_owned()),
        ]
    );
}

// Requirements: CORE-190. The record is taken after the request hook: its text holds the condition that the hook added
// and its values hold the parameter that the hook added. with_request_hook of a logging handle keeps the log.
#[tokio::test]
async fn a_request_is_recorded_after_its_hook_with_what_the_hook_added() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-request-log-hook");
    let (db, schema) = clock_db(&scratch).await;
    let logging = db.with_request_log();
    let hooked = logging.with_request_hook(|request: &mut Request, params: &mut RequestParams| {
        Box::pin(async move {
            add_equal(request, params, "label", "first");
            Ok(())
        })
    });
    let found = events(&schema, Connection::from(&hooked)).get_by("Seq", &[OrmValue::Int(1)]).await.expect("the read");
    assert!(found.is_none(), "the table holds no row");
    let records = logging.observed_requests();
    assert_eq!(records.len(), 1, "{records:?}");
    let request = Request::from_json(&records[0].request).expect("a recorded text is a request of the form");
    assert_eq!((request.kind.as_str(), request.query.entity.as_str(), request.n_params), ("one", "clock_event", 2));
    assert_eq!(request.manifest_hash, CLOCK_HASH);
    assert_eq!(where_columns(&records[0].request), ["seq", "label"]);
    assert_eq!(records[0].params, [OrmValue::Int64(1), OrmValue::Text("first".to_owned())]);
    db.close_async().await;
}

// Requirements: CORE-190. A request whose hook failed is not recorded.
#[tokio::test]
async fn a_request_whose_hook_failed_is_not_recorded() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-request-log-refused");
    let (db, schema) = clock_db(&scratch).await;
    let logging = db.with_request_log();
    let hooked =
        logging.with_request_hook(|_request: &mut Request, _params: &mut RequestParams| Box::pin(async move { Err(Error::config("the hook refuses")) }));
    let error = events(&schema, Connection::from(&hooked)).get_count().await.expect_err("a request that its hook refuses");
    assert_eq!(error.to_string(), "config: the hook refuses");
    assert!(logging.observed_requests().is_empty());
    db.close_async().await;
}

// Requirements: CORE-190. A request that the planner refuses is recorded, because the record is taken before the
// request is planned.
#[tokio::test]
async fn a_request_that_the_planner_refuses_is_recorded() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-request-log-planning");
    let (db, schema) = clock_db(&scratch).await;
    let logging = db.with_request_log();
    let hooked = logging.with_request_hook(|request: &mut Request, params: &mut RequestParams| {
        Box::pin(async move {
            add_equal(request, params, "nothing", "x");
            Ok(())
        })
    });
    let error = events(&schema, Connection::from(&hooked)).get_count().await.expect_err("a condition on a column that the entity lacks");
    assert_eq!(error.kind(), Kind::ColumnUnknown, "{error}");
    let records = logging.observed_requests();
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(where_columns(&records[0].request), ["nothing"]);
    assert_eq!(records[0].params, [OrmValue::Text("x".to_owned())]);
    db.close_async().await;
}

// Requirements: CORE-190. observed_requests returns the records in the order of the requests and empties the log, and a
// handle without a log returns an empty list and records nothing.
#[tokio::test]
async fn reading_the_log_empties_it() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-request-log-drain");
    let (db, schema) = clock_db(&scratch).await;
    let logging = db.with_request_log();
    let query = events(&schema, Connection::from(&logging));
    assert_eq!(query.get_count().await.expect("the count"), 0);
    assert!(query.get_by("Seq", &[OrmValue::Int(2)]).await.expect("the read").is_none());
    let kinds: Vec<String> =
        logging.observed_requests().iter().map(|record| Request::from_json(&record.request).expect("a recorded text is a request of the form").kind).collect();
    assert_eq!(kinds, ["count", "one"]);
    assert!(logging.observed_requests().is_empty(), "the first read emptied the log");
    assert_eq!(query.get_count().await.expect("the count"), 0);
    assert_eq!(logging.observed_requests().len(), 1, "the log records after a read");
    assert_eq!(events(&schema, Connection::from(&db)).get_count().await.expect("the count of the handle without a log"), 0);
    assert!(db.observed_requests().is_empty(), "a handle without a log has no record");
    assert!(logging.observed_requests().is_empty(), "a request of another handle of the connection is not recorded");
    db.close_async().await;
}

// Requirements: CORE-190. with_cancel of a logging handle keeps the log, and with_request_log of a logging handle gives
// a log of its own.
#[tokio::test]
async fn a_handle_made_from_a_logging_handle_keeps_the_log() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-request-log-handles");
    let (db, schema) = clock_db(&scratch).await;
    let logging = db.with_request_log();
    let (_trigger, cancel) = cancel_pair();
    let cancellable = logging.with_cancel(cancel);
    assert_eq!(events(&schema, Connection::from(&cancellable)).get_count().await.expect("the count"), 0);
    assert_eq!(logging.observed_requests().len(), 1, "the handle of with_cancel records in the log of its handle");
    let second = logging.with_request_log();
    assert_eq!(events(&schema, Connection::from(&second)).get_count().await.expect("the count"), 0);
    assert!(logging.observed_requests().is_empty(), "a second log takes the requests of its own handle");
    assert_eq!(second.observed_requests().len(), 1);
    db.close_async().await;
}

// Requirements: CORE-190. A request of a model connected to the Tx of a transaction that a logging handle began is
// recorded in the log of that handle.
#[tokio::test]
async fn a_request_of_a_transaction_of_the_handle_is_recorded() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-request-log-transaction");
    let (db, schema) = clock_db(&scratch).await;
    let logging = db.with_request_log();
    let count = logging
        .transaction_async(
            |tx| {
                let schema = &schema;
                async move { events(schema, Connection::from(&tx)).get_count().await }
            },
            TransactionOptions::default(),
        )
        .await
        .expect("the transaction");
    assert_eq!(count, 0);
    let records = logging.observed_requests();
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(Request::from_json(&records[0].request).expect("a recorded text is a request of the form").kind, "count");
    db.close_async().await;
}

// Requirements: CORE-190. A step of Db::execute passes no request of a model and is not recorded.
#[tokio::test]
async fn a_step_of_execute_is_not_recorded() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-request-log-execute");
    let (db, _schema) = clock_db(&scratch).await;
    let logging = db.with_request_log();
    let step = r#"{"id":1,"role":"main","sql":"INSERT INTO clock_event (seq, label) VALUES (1, 'first')","tables":[],"bind_slots":[]}"#;
    logging.execute_text(step, Vec::new()).await.expect("the step");
    assert!(logging.observed_requests().is_empty());
    db.close_async().await;
}
