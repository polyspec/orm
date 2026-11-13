// The members of the general query that the Db step needs (CORE-85 to CORE-91): limit, the row locks, the columns of a
// row, relations, key_name, where_in and the writes. The cases that send statements run on a SQLite file of their own,
// and the cases of the MySQL and PostgreSQL statements compile the request of a query for that dialect.

use crate::db::Pool;
use crate::test_support::Scratch;
use crate::{Config, Connection, Db, Error, OrmValue, Query, Result, Schema};

/// Two tables: `account`, with a unique email, a column that the default select set leaves out and a revision, and
/// `account_key`, whose rows reference an account.
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

fn int(value: i64) -> OrmValue {
    OrmValue::Int64(value)
}

/// A SQLite database with the tables of the account schema, the accounts 1 to 3 and the keys 1 and 2 of account 1 and
/// the key 3 of account 2.
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

fn query(schema: &Schema, entity: &str, db: &Db) -> Query {
    let mut query = Query::new(schema, entity).expect("query");
    query.connect(Connection::from(db));
    query
}

/// The error of a result that the case expects to fail.
fn failure<T>(result: Result<T>, what: &str) -> Error {
    match result {
        Ok(_) => panic!("{what}: succeeded, and the case expects a failure"),
        Err(error) => error,
    }
}

fn seqs(rows: &crate::Collection<Query>) -> Vec<OrmValue> {
    rows.models().map(|row| row.value("seq").expect("seq")).collect()
}

// Requirements: CORE-85. limit reads at most count rows after offset rows of the order, and a count of 0 is config at
// the next terminal.
#[tokio::test]
async fn limit_reads_a_range_of_the_order() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let scratch = Scratch::new("orm-rust-query-limit");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let mut newest = query(&schema, "account", &db);
    newest.order_by("SeqDesc");
    newest.limit(0, 1);
    let rows = newest.gets().await.expect("gets");
    assert_eq!(seqs(&rows), [int(3)], "the newest row alone");
    let mut middle = query(&schema, "account", &db);
    middle.order_by("SeqAsc");
    middle.limit(1, 2);
    assert_eq!(seqs(&middle.gets().await.expect("gets")), [int(2), int(3)], "two rows after the first");
    let mut none = query(&schema, "account", &db);
    none.limit(0, 0);
    let error = failure(none.gets().await, "a count of 0");
    assert_eq!(error.to_string(), "config: limit requires a non-negative offset and a positive count");
    db.close().await;
}

/// The statement of the first step of the request `kind` of `query` for `dialect`, as a connection of that dialect plans
/// it.
fn statement(query: &Query, kind: &str, dialect: crate::Dialect) -> Result<String> {
    let req = crate::request::build(&query.core, kind);
    if let Some(error) = req.error() {
        return Err(error);
    }
    let manifest = query.core.entity().schema().manifest()?;
    let plan = crate::engine::compile(&manifest, dialect, &req.ir)?;
    Ok(plan.steps[0].sql.clone())
}

// Requirements: CORE-86. Each of the four locks sets the lock of the request, the last one called holds, and MySQL and
// PostgreSQL render it after the statement.
#[test]
fn the_four_locks_set_the_lock_of_the_request() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let schema = account_schema();
    let cases: [(fn(&mut Query), &str, &str, &str); 4] = [
        (Query::for_update, "update", " FOR UPDATE", " FOR UPDATE"),
        (Query::for_share, "share", " LOCK IN SHARE MODE", " FOR SHARE"),
        (Query::for_update_no_wait, "update_nowait", " FOR UPDATE NOWAIT", " FOR UPDATE NOWAIT"),
        (Query::for_share_no_wait, "share_nowait", " FOR SHARE NOWAIT", " FOR SHARE NOWAIT"),
    ];
    for (lock, mode, mysql, postgres) in cases {
        let mut query = Query::new(&schema, "account").expect("query");
        query.for_update();
        lock(&mut query);
        let req = crate::request::build(&query.core, "one");
        assert_eq!(req.ir.query.lock, mode, "the last lock holds");
        let sql = statement(&query, "one", crate::Dialect::MySql).expect("MySQL statement");
        assert!(sql.ends_with(mysql), "{mode} on MySQL: {sql}");
        let sql = statement(&query, "one", crate::Dialect::Postgres).expect("PostgreSQL statement");
        assert!(sql.ends_with(postgres), "{mode} on PostgreSQL: {sql}");
    }
    let mut counted = Query::new(&schema, "account").expect("query");
    counted.for_update();
    let error = statement(&counted, "count", crate::Dialect::Postgres).expect_err("a count with a lock");
    assert_eq!(error.kind(), crate::Kind::IrInvalid, "{error}");
}

// Requirements: CORE-86. SQLite takes the lock of a read in a transaction, and refuses a lock outside one.
#[tokio::test]
async fn a_lock_on_sqlite_needs_a_transaction() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let scratch = Scratch::new("orm-rust-query-lock");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let mut outside = query(&schema, "account", &db);
    outside.for_update();
    let error = failure(outside.get().await, "a lock outside a transaction");
    assert_eq!(error.to_string(), "config: SQLite row locks require an ORM transaction");
    let locked = db
        .transaction(
            |tx| {
                let schema = &schema;
                async move {
                    let mut query = Query::new(schema, "account")?;
                    query.connect(Connection::from(&tx));
                    query.where_chain("Seq", vec![int(2)]);
                    query.for_update();
                    query.get().await?.map(|row| row.value("email")).transpose()
                }
            },
            crate::TransactionOptions::default(),
        )
        .await
        .expect("a locked read in a transaction");
    assert_eq!(locked, Some(OrmValue::Text("b@x".into())));
    db.close().await;
}
