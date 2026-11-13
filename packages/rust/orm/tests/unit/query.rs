// The general query of the core (CORE-80 to CORE-83): a schema value loaded at run time, a `Query` of an entity
// chosen by its name, its chain conditions, its order, its terminals and the values of its rows. The cases that send
// statements run on a SQLite file of their own.

use crate::db::Pool;
use crate::test_support::Scratch;
use crate::{Config, Connection, Db, Kind, OrmValue, Query, Schema};

const CLOCK: &str = include_str!("../../../../../contracts/fixtures/clock.dbs");
const CLOCK_HASH: &str = "sha256:fab61fb83cfec00c4d7a4d257b610b87c6fdccd49e02a85848a41ba263bc1ffb";

fn clock() -> Schema {
    Schema::load(CLOCK, "", CLOCK_HASH).expect("clock.dbs loads")
}

fn int(value: i64) -> OrmValue {
    OrmValue::Int64(value)
}

fn text(value: &str) -> OrmValue {
    OrmValue::Text(value.into())
}

/// A SQLite database with the table of clock.dbs and the rows (1, first), (2, second), (3, third).
async fn clock_db(scratch: &Scratch, schema: &Schema) -> Db {
    let db = Db::connect(&format!("sqlite://{}", scratch.join("clock.sqlite").display()), 1, Config::default()).await.expect("connect");
    db.utils().schema().install(schema).await.expect("install");
    let Pool::Sqlite(pool) = &db.inner.pool else { panic!("the case uses SQLite") };
    sqlx::query("INSERT INTO clock_event (seq, label) VALUES (1, 'first'), (2, 'second'), (3, 'third')").execute(pool).await.expect("insert rows");
    db
}

// Requirements: CORE-80. A text that is no manifest and a text that does not hash to its hash are refused at the load.
#[test]
fn schema_load_refuses_a_text_that_is_no_manifest_of_its_hash() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    assert_eq!(clock().hash(), CLOCK_HASH);
    let error = Schema::load("not a manifest", "", CLOCK_HASH).err().expect("a text that is no manifest");
    assert_eq!(error.kind(), Kind::SchemaInvalid, "{error}");
    let edited = CLOCK.replace("varchar(32)", "varchar(64)");
    assert_ne!(edited, CLOCK, "the fixture declares label varchar(32)");
    let error = Schema::load(&edited, "", CLOCK_HASH).err().expect("an edited manifest");
    assert_eq!(error.kind(), Kind::SchemaHashMismatch, "{error}");
}

// Requirements: CORE-80, CORE-81. A loaded schema is shared by its copies, its queries, their rows and the connection that
// it is registered on, and its memory is returned when the last of them is dropped; the process keeps none.
#[tokio::test]
async fn the_memory_of_a_loaded_schema_returns_with_its_last_owner() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let scratch = Scratch::new("orm-rust-query-schema-memory");
    let schema = clock();
    let text = schema.text_owners().expect("a loaded schema owns its text");
    let db = clock_db(&scratch, &schema).await;
    let mut query = Query::new(&schema, "clock_event").expect("query");
    query.connect(Connection::from(&db));
    query.where_chain("GtSeq", vec![int(1)]);
    let rows = query.gets().await.expect("gets");
    let row = query.get().await.expect("get").expect("a row");
    assert_eq!(rows.len(), 2);
    drop(schema);
    assert!(text.upgrade().is_some(), "the query, its rows and the connection share the schema");
    drop(query);
    assert_eq!(row.value("seq").expect("seq"), int(2), "a row keeps the schema that it reads its columns by");
    drop(rows);
    drop(row);
    assert!(text.upgrade().is_some(), "the connection that the schema is registered on shares it");
    db.close().await;
    drop(db);
    assert!(text.upgrade().is_none(), "the last owner is dropped, so the text of the schema is returned");

    // A schema that no connection registered is returned with its last query.
    let schema = clock();
    let text = schema.text_owners().expect("a loaded schema owns its text");
    let query = Query::new(&schema, "clock_event").expect("query");
    let copy = query.clone();
    drop(schema);
    drop(query);
    assert!(text.upgrade().is_some(), "a copy of the query shares the schema");
    drop(copy);
    assert!(text.upgrade().is_none());
}

// Requirements: CORE-81. The entity is chosen by its name, and a name that the schema does not have is entity_unknown.
#[test]
fn query_new_takes_an_entity_of_the_schema() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let schema = clock();
    assert_eq!(Query::new(&schema, "clock_event").expect("an entity of the schema").entity(), "clock_event");
    let error = Query::new(&schema, "clock_tick").err().expect("no entity of the schema");
    assert_eq!(error.kind(), Kind::EntityUnknown, "{error}");
    assert_eq!(error.to_string(), "entity_unknown: clock_tick");
}

// Requirements: CORE-81. A terminal of a query with no connection is config.
#[tokio::test]
async fn a_terminal_without_a_connection_is_config() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let query = Query::new(&clock(), "clock_event").expect("query");
    let error = query.get_count().await.expect_err("no connection");
    assert_eq!(error.to_string(), "config: the model has no connection; connect it to a Db or to the Tx of a transaction");
}

// Requirements: CORE-82. A name that is no chain of the entity, an operator that the column does not allow and a number
// of values other than the number of keys are config at the next terminal.
#[tokio::test]
async fn a_chain_that_the_entity_does_not_have_is_config_at_the_terminal() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let schema = clock();
    for (chain, args, message) in [
        ("Missing", vec![int(1)], "config: Missing is not a column of clock_event"),
        ("", vec![], "config: empty condition name"),
        ("SeqAndLabel", vec![int(1)], "config: the condition expects 2 values"),
        ("LkSeq", vec![int(1)], "config: LkSeq: clock_event.seq does not accept the lk operator"),
    ] {
        let mut query = Query::new(&schema, "clock_event").expect("query");
        query.where_chain(chain, args);
        let error = query.get_count().await.expect_err("a refused chain");
        assert_eq!(error.to_string(), message, "chain {chain:?}");
    }
    let mut query = Query::new(&schema, "clock_event").expect("query");
    query.order_by("SeqUp");
    let error = query.get_count().await.expect_err("a refused order");
    assert_eq!(error.to_string(), "config: orderBySeqUp: each key ends with Asc or Desc");
}

// Requirements: CORE-82, CORE-83. The conditions of a chain select the rows, the order orders them, and a row holds the
// values of its columns.
#[tokio::test]
async fn where_and_order_by_select_and_order_the_rows() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let scratch = Scratch::new("orm-rust-query-rows");
    let schema = clock();
    let db = clock_db(&scratch, &schema).await;
    let mut query = Query::new(&schema, "clock_event").expect("query");
    query.connect(Connection::from(&db));
    assert_eq!(query.get_count().await.expect("count of every row"), 3);
    query.where_chain("GtSeq", vec![int(1)]);
    query.order_by("SeqDesc");
    assert_eq!(query.get_count().await.expect("count"), 2, "seq > 1");
    let rows = query.gets().await.expect("gets");
    let labels: Vec<OrmValue> = rows.models().map(|row| row.value("label").expect("label")).collect();
    assert_eq!(labels, [text("third"), text("second")], "seq > 1 in descending order");
    let first = query.get().await.expect("get").expect("a row");
    assert_eq!(first.entity(), "clock_event");
    assert_eq!(first.value("seq").expect("seq"), int(3), "the integer of an i64 column is int64");
    // A connector at the start of the name joins the chain to the conditions before it.
    query.where_chain("OrLabel", vec![text("first")]);
    assert_eq!(query.get_count().await.expect("count"), 3, "seq > 1 or label = first");
    let statement = query.get_query().await.expect("statement");
    assert!(statement.sql.contains(" OR "), "the statement joins the two conditions with OR: {}", statement.sql);
    db.close().await;
}

// Requirements: CORE-83. A terminal with a chain adds its conditions with and, and does not change the query.
#[tokio::test]
async fn a_terminal_with_a_chain_leaves_the_query_unchanged() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let scratch = Scratch::new("orm-rust-query-by");
    let schema = clock();
    let db = clock_db(&scratch, &schema).await;
    let mut query = Query::new(&schema, "clock_event").expect("query");
    query.connect(Connection::from(&db));
    query.where_chain("GtSeq", vec![int(1)]);
    assert_eq!(query.get_count_by("Label", vec![text("third")]).await.expect("count by"), 1, "seq > 1 and label = third");
    assert_eq!(query.gets_by("LtSeq", vec![int(3)]).await.expect("gets by").len(), 1, "seq > 1 and seq < 3");
    let row = query.get_by("Label", vec![text("second")]).await.expect("get by").expect("a row");
    assert_eq!(row.value("seq").expect("seq"), int(2));
    assert!(query.get_by("Label", vec![text("first")]).await.expect("get by").is_none(), "seq > 1 and label = first matches no row");
    assert_eq!(query.get_count().await.expect("count"), 2, "the query keeps only its own condition");
    db.close().await;
}

// Requirements: CORE-83. A name that is no column of the entity is column_unknown, and a column that the row did not
// read is column_unselected.
#[tokio::test]
async fn value_names_a_column_that_the_row_read() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let scratch = Scratch::new("orm-rust-query-value");
    let schema = clock();
    let db = clock_db(&scratch, &schema).await;
    let mut query = Query::new(&schema, "clock_event").expect("query");
    let error = query.value("label").expect_err("a query that read no row");
    assert_eq!(error.to_string(), "column_unselected: clock_event.label was not loaded or assigned");
    query.connect(Connection::from(&db));
    let row = query.get_by("Seq", vec![int(1)]).await.expect("get by").expect("a row");
    assert_eq!(row.value("label").expect("label"), text("first"));
    let error = row.value("missing").expect_err("no column of the entity");
    assert_eq!(error.to_string(), "column_unknown: clock_event.missing");
    db.close().await;
}

// Requirements: CORE-81, CORE-20. A query that is connected to the Tx of a transaction runs in that transaction.
#[tokio::test]
async fn a_query_runs_in_the_transaction_it_is_connected_to() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let scratch = Scratch::new("orm-rust-query-tx");
    let schema = clock();
    let db = clock_db(&scratch, &schema).await;
    let counted = db
        .transaction(
            |tx| {
                let schema = &schema;
                async move {
                    let mut query = Query::new(schema, "clock_event")?;
                    query.connect(Connection::from(&tx));
                    query.get_count().await
                }
            },
            crate::TransactionOptions::default(),
        )
        .await
        .expect("transaction");
    assert_eq!(counted, 3);
    db.close().await;
}
