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

fn text(value: &str) -> OrmValue {
    OrmValue::Text(value.into())
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
