// The Db step (CORE-92): a query tree held as JSON that a runner runs on its connection, its calls in order and its
// terminal, and the outcome of its result or of the kind of its failure. The cases run on a SQLite file of their own.

use serde_json::{json, Value};

use crate::db::Pool;
use crate::test_support::Scratch;
use crate::{Config, Connection, Db, Schema, StepRunner};

const ACCOUNT: &str = "dbspec 1 account

table account {
  seq i64 identity
  email varchar(64)
  name varchar(32) null
  revision i64
  primary key (seq)
  unique uq_account_email (email)
  settings {
    select explicit name
  }
}

table account_key {
  seq i64 identity
  account_seq i64
  label varchar(32)
  primary key (seq)
  index ix_account_key_account (account_seq)
  foreign key fk_account_key_account (account_seq) references account (seq) on delete restrict on update restrict
}
";
const ACCOUNT_HASH: &str = "sha256:21700a328449535485eb78d219d2b73bb8cf0c5df7411089c0f2bf3e38b135dc";

fn account_schema() -> Schema {
    Schema::load(ACCOUNT, "", ACCOUNT_HASH).expect("the account schema loads")
}

/// A SQLite database with the accounts 1 to 3, the keys 1 and 2 of account 1 and the key 3 of account 2.
async fn account_db(scratch: &Scratch, schema: &Schema) -> Db {
    let db = Db::connect(&format!("sqlite://{}", scratch.join("account.sqlite").display()), 1, Config::default()).await.expect("connect");
    db.utils().schema().install(schema).await.expect("install");
    let Pool::Sqlite(pool) = &db.inner.pool else { panic!("the case uses SQLite") };
    for statement in [
        "INSERT INTO account (seq, email, name, revision) VALUES (1, 'a@x', 'Ann', 0), (2, 'b@x', 'Bob', 0), (3, 'c@x', NULL, 0)",
        "INSERT INTO account_key (seq, account_seq, label) VALUES (1, 1, 'k1'), (2, 1, 'k2'), (3, 2, 'k3')",
    ] {
        sqlx::query(statement).execute(pool).await.expect("insert rows");
    }
    db
}

/// The outcome of the step `step` that `runner` ran, as JSON.
async fn run(runner: &mut StepRunner, step: &Value) -> Value {
    let outcome = runner.run(&step.to_string()).await;
    match serde_json::from_str(&outcome) {
        Ok(value) => value,
        Err(error) => panic!("the outcome {outcome} is no JSON: {error}"),
    }
}

fn query_step(query: Value, terminal: &str) -> Value {
    json!({"kind": "query", "query": query, "terminal": terminal})
}

fn int64(n: i64) -> Value {
    json!({"kind": "int64", "value": n})
}

fn text(value: &str) -> Value {
    json!({"kind": "text", "value": value})
}

/// The kind of the error of an outcome; it panics on an outcome that succeeded.
fn error_kind(outcome: &Value) -> &str {
    outcome["error"]["kind"].as_str().unwrap_or_else(|| panic!("the outcome {outcome} is no error"))
}

// Requirements: CORE-92. A read step runs its calls in order and its terminal, and its result holds the columns that a
// row read, the rows of a relations result and the key of each row.
#[tokio::test]
async fn a_read_step_runs_its_calls_and_its_terminal() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let scratch = Scratch::new("orm-rust-step-read");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let mut runner = StepRunner::new(&schema, Connection::from(&db));
    let newest = json!({"entity": "account", "calls": [
        {"call": "where", "chain": "Email", "values": [text("a@x")]},
        {"call": "add_all_columns"},
        {"call": "order_by", "spec": "SeqDesc"},
        {"call": "limit", "offset": 0, "count": 1},
    ]});
    let row = json!({"values": {"seq": int64(1), "email": text("a@x"), "name": text("Ann"), "revision": int64(0)}, "related": {}});
    assert_eq!(run(&mut runner, &query_step(newest, "get")).await, json!({"ok": {"row": row}}));
    let missing = json!({"entity": "account", "calls": [{"call": "where", "chain": "Seq", "values": [int64(9)]}]});
    assert_eq!(run(&mut runner, &query_step(missing, "get")).await, json!({"ok": {"row": null}}));
    let counted = json!({"entity": "account", "calls": [{"call": "where", "chain": "GtSeq", "values": [int64(1)]}]});
    assert_eq!(run(&mut runner, &query_step(counted, "get_count")).await, json!({"ok": {"count": 2}}));
    let keys = json!({"entity": "account_key", "calls": [
        {"call": "match_pair", "pair": "SeqWithAccountSeq"},
        {"call": "remove_all_columns"},
        {"call": "add_column", "column": "label"},
        {"call": "order_by", "spec": "SeqAsc"},
        {"call": "alias", "name": "keys"},
    ]});
    let accounts = json!({"entity": "account", "calls": [
        {"call": "where_in", "chain": "Seq", "query": {"entity": "account_key", "calls": [{"call": "add_column", "column": "account_seq"}]}},
        {"call": "remove_all_columns"},
        {"call": "add_column", "column": "email"},
        {"call": "key_name", "column": "email"},
        {"call": "order_by", "spec": "SeqAsc"},
        {"call": "relations", "query": keys},
    ]});
    let key = |seq: i64, account: i64, label: &str| json!({"values": {"seq": int64(seq), "account_seq": int64(account), "label": text(label)}, "related": {}});
    let rows = json!([
        {"key": "a@x", "row": {"values": {"seq": int64(1), "email": text("a@x")}, "related": {"keys": [key(1, 1, "k1"), key(2, 1, "k2")]}}},
        {"key": "b@x", "row": {"values": {"seq": int64(2), "email": text("b@x")}, "related": {"keys": [key(3, 2, "k3")]}}},
    ]);
    assert_eq!(run(&mut runner, &query_step(accounts, "gets")).await, json!({"ok": {"rows": rows}}));
    runner.close().await;
    db.close().await;
}

// Requirements: CORE-92. A write step writes, its result holds the created row, and a failure returns its kind, such as
// duplicate_key, to the core that asked.
#[tokio::test]
async fn a_write_step_returns_its_row_or_the_kind_of_its_failure() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let scratch = Scratch::new("orm-rust-step-write");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let mut runner = StepRunner::new(&schema, Connection::from(&db));
    let insert = |email: &str| {
        json!({"entity": "account", "calls": [
            {"call": "set", "column": "email", "value": text(email)},
            {"call": "set", "column": "revision", "value": int64(0)},
        ]})
    };
    let created = run(&mut runner, &query_step(insert("d@x"), "create")).await;
    assert_eq!(created, json!({"ok": {"row": {"values": {"seq": int64(4), "email": text("d@x"), "revision": int64(0)}, "related": {}}}}));
    let duplicate = run(&mut runner, &query_step(insert("a@x"), "create")).await;
    assert_eq!(error_kind(&duplicate), "duplicate_key", "{duplicate}");
    let rename = json!({"entity": "account", "calls": [
        {"call": "set", "column": "seq", "value": int64(2)},
        {"call": "set", "column": "name", "value": text("Bea")},
        {"call": "expect_revision", "column": "revision", "revision": 0},
    ]});
    assert_eq!(run(&mut runner, &query_step(rename.clone(), "update")).await, json!({"ok": {}}));
    let stale = run(&mut runner, &query_step(rename, "update")).await;
    assert_eq!(error_kind(&stale), "revision_changed", "the revision is 1 after the first update: {stale}");
    let named = json!({"entity": "account", "calls": [{"call": "where", "chain": "Name", "values": [text("Bea")]}]});
    assert_eq!(run(&mut runner, &query_step(named, "get_count")).await, json!({"ok": {"count": 1}}));
    let remove = json!({"entity": "account_key", "calls": [{"call": "set", "column": "seq", "value": int64(3)}]});
    assert_eq!(run(&mut runner, &query_step(remove, "delete")).await, json!({"ok": {}}));
    let keys = json!({"entity": "account_key", "calls": []});
    assert_eq!(run(&mut runner, &query_step(keys, "get_count")).await, json!({"ok": {"count": 2}}));
    runner.close().await;
    db.close().await;
}

// Requirements: CORE-92. A text that is no step, a call or a terminal that no step has, a value of no kind of
// orm_value and an entity that the schema does not have each return the kind of the failure.
#[tokio::test]
async fn a_step_that_the_runner_cannot_read_returns_its_kind() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let scratch = Scratch::new("orm-rust-step-refused");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let mut runner = StepRunner::new(&schema, Connection::from(&db));
    let outcome: Value = serde_json::from_str(&runner.run("not a step").await).expect("an outcome is JSON");
    assert_eq!(error_kind(&outcome), "config", "{outcome}");
    for (what, step, kind) in [
        ("a call that no step has", query_step(json!({"entity": "account", "calls": [{"call": "drop_table"}]}), "get"), "config"),
        ("a terminal that no step has", query_step(json!({"entity": "account", "calls": []}), "truncate"), "config"),
        (
            "a value of no kind",
            query_step(json!({"entity": "account", "calls": [{"call": "where", "chain": "Seq", "values": [{"kind": "date", "value": 1}]}]}), "get"),
            "config",
        ),
        ("an entity of no table", query_step(json!({"entity": "ledger", "calls": []}), "get"), "entity_unknown"),
        (
            "a chain of no column",
            query_step(json!({"entity": "account", "calls": [{"call": "where", "chain": "Missing", "values": [int64(1)]}]}), "get"),
            "config",
        ),
    ] {
        let outcome = run(&mut runner, &step).await;
        assert_eq!(error_kind(&outcome), kind, "{what}: {outcome}");
        assert!(outcome["error"]["message"].as_str().is_some_and(|message| message.starts_with(&format!("{kind}: "))), "{what}: {outcome}");
    }
    runner.close().await;
    db.close().await;
}

/// The step that creates the account of `email`.
fn create_account(email: &str) -> Value {
    query_step(
        json!({"entity": "account", "calls": [
            {"call": "set", "column": "email", "value": text(email)},
            {"call": "set", "column": "revision", "value": int64(0)},
        ]}),
        "create",
    )
}

/// The step that counts the accounts of `email`.
fn count_account(email: &str) -> Value {
    query_step(json!({"entity": "account", "calls": [{"call": "where", "chain": "Email", "values": [text(email)]}]}), "get_count")
}

fn end(rollback: bool) -> Value {
    json!({"kind": "end", "rollback": rollback})
}

// Requirements: CORE-93. The steps between a transaction step and its end run in one transaction, which the end commits
// or rolls back.
#[tokio::test]
async fn a_transaction_step_runs_the_steps_until_its_end() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let scratch = Scratch::new("orm-rust-step-transaction");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let mut runner = StepRunner::new(&schema, Connection::from(&db));
    let ok = json!({"ok": {}});
    assert_eq!(run(&mut runner, &json!({"kind": "transaction", "options": {}})).await, ok);
    assert!(run(&mut runner, &create_account("d@x")).await["ok"]["row"].is_object());
    let locked = query_step(json!({"entity": "account", "calls": [{"call": "where", "chain": "Email", "values": [text("d@x")]}, {"call": "for_update"}]}), "get");
    assert!(run(&mut runner, &locked).await["ok"]["row"].is_object(), "a locked read in the transaction sees its own row");
    assert_eq!(run(&mut runner, &end(false)).await, ok, "the end commits");
    assert_eq!(run(&mut runner, &count_account("d@x")).await, json!({"ok": {"count": 1}}));
    assert_eq!(run(&mut runner, &json!({"kind": "transaction"})).await, ok, "the options are optional");
    assert!(run(&mut runner, &create_account("e@x")).await["ok"]["row"].is_object());
    assert_eq!(run(&mut runner, &end(true)).await, ok, "the end rolls back");
    assert_eq!(run(&mut runner, &count_account("e@x")).await, json!({"ok": {"count": 0}}));
    runner.close().await;
    db.close().await;
}

// Requirements: CORE-93. A savepoint step opens a savepoint of the innermost transaction, so a write that fails with
// duplicate_key is rolled back to it and the transaction goes on.
#[tokio::test]
async fn a_savepoint_step_rolls_back_to_its_start() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let scratch = Scratch::new("orm-rust-step-savepoint");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let mut runner = StepRunner::new(&schema, Connection::from(&db));
    let ok = json!({"ok": {}});
    assert_eq!(run(&mut runner, &json!({"kind": "transaction", "options": {"isolation": "serializable"}})).await, ok);
    assert!(run(&mut runner, &create_account("d@x")).await["ok"]["row"].is_object());
    assert_eq!(run(&mut runner, &json!({"kind": "savepoint"})).await, ok);
    assert!(run(&mut runner, &create_account("e@x")).await["ok"]["row"].is_object());
    let duplicate = run(&mut runner, &create_account("a@x")).await;
    assert_eq!(error_kind(&duplicate), "duplicate_key", "{duplicate}");
    assert_eq!(run(&mut runner, &end(true)).await, ok, "the end rolls back to the savepoint");
    assert_eq!(run(&mut runner, &json!({"kind": "savepoint"})).await, ok);
    assert!(run(&mut runner, &create_account("f@x")).await["ok"]["row"].is_object());
    assert_eq!(run(&mut runner, &end(false)).await, ok, "the end releases the savepoint");
    assert_eq!(run(&mut runner, &end(false)).await, ok, "the end commits the transaction");
    for (email, count) in [("d@x", 1), ("e@x", 0), ("f@x", 1)] {
        assert_eq!(run(&mut runner, &count_account(email)).await, json!({"ok": {"count": count}}), "{email}");
    }
    runner.close().await;
    db.close().await;
}

// Requirements: CORE-93. A savepoint or an end with no open transaction and an option that no step has are config, and
// close rolls back what is open and leaves the runner on its connection.
#[tokio::test]
async fn close_rolls_back_what_is_open() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let scratch = Scratch::new("orm-rust-step-close");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let mut runner = StepRunner::new(&schema, Connection::from(&db));
    for (what, step) in [
        ("a savepoint without a transaction", json!({"kind": "savepoint"})),
        ("an end without a transaction", end(false)),
        ("an option that no step has", json!({"kind": "transaction", "options": {"retry": 3}})),
    ] {
        let outcome = run(&mut runner, &step).await;
        assert_eq!(error_kind(&outcome), "config", "{what}: {outcome}");
    }
    let ok = json!({"ok": {}});
    assert_eq!(run(&mut runner, &json!({"kind": "transaction"})).await, ok);
    assert_eq!(run(&mut runner, &json!({"kind": "savepoint"})).await, ok);
    assert!(run(&mut runner, &create_account("d@x")).await["ok"]["row"].is_object());
    runner.close().await;
    assert_eq!(run(&mut runner, &count_account("d@x")).await, json!({"ok": {"count": 0}}), "close rolled back both");
    let outcome = run(&mut runner, &end(false)).await;
    assert_eq!(error_kind(&outcome), "config", "close ended every open one: {outcome}");
    runner.close().await;
    db.close().await;
}

// Requirements: CORE-93. A runner dropped with an open transaction rolls it back, and the connection of the pool of one
// returns to the pool, where the next statement takes it.
#[tokio::test]
async fn a_dropped_runner_rolls_back_its_transaction() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let scratch = Scratch::new("orm-rust-step-drop");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let mut runner = StepRunner::new(&schema, Connection::from(&db));
    assert_eq!(run(&mut runner, &json!({"kind": "transaction"})).await, json!({"ok": {}}));
    assert!(run(&mut runner, &create_account("d@x")).await["ok"]["row"].is_object());
    drop(runner);
    let mut next = StepRunner::new(&schema, Connection::from(&db));
    assert_eq!(run(&mut next, &count_account("d@x")).await, json!({"ok": {"count": 0}}));
    next.close().await;
    db.close().await;
}
