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
    let _case = polyspec_orm_testcase::case!();
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

/// A lock member with the lock that it sets and its clause on MySQL and on PostgreSQL.
type LockCase = (fn(&mut Query), &'static str, &'static str, &'static str);

// Requirements: CORE-86. Each of the four locks sets the lock of the request, the last one called holds, and MySQL and
// PostgreSQL render it after the statement.
#[test]
fn the_four_locks_set_the_lock_of_the_request() {
    let _case = polyspec_orm_testcase::case!();
    let schema = account_schema();
    let cases: [LockCase; 4] = [
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

// Requirements: CORE-86. A lock outside a transaction is config, and a locked read inside one reads its row.
#[tokio::test]
async fn a_lock_needs_a_transaction() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-query-lock");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let mut outside = query(&schema, "account", &db);
    outside.for_update();
    let error = failure(outside.get().await, "a lock outside a transaction");
    assert_eq!(error.to_string(), "config: row locks are allowed only inside a transaction");
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

/// The message of the value of `column` of `row`: `Ok` with the value, or the error text.
fn read(row: &Query, column: &str) -> std::result::Result<OrmValue, String> {
    row.value(column).map_err(|error| error.to_string())
}

// Requirements: CORE-87. The default select set leaves out a column of select explicit; add_all_columns reads it,
// remove_all_columns keeps the keys, add_column adds one column and remove_column removes one.
#[tokio::test]
async fn the_columns_of_a_row_follow_the_column_members() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-query-columns");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let unselected = |column: &str| Err(format!("column_unselected: account.{column} was not loaded or assigned"));
    let mut first = query(&schema, "account", &db);
    first.where_chain("Seq", vec![int(1)]);
    let row = first.get().await.expect("get").expect("a row");
    assert_eq!(read(&row, "name"), unselected("name"), "select explicit leaves name out");
    assert_eq!(read(&row, "email"), Ok(OrmValue::Text("a@x".into())));
    let mut all = first.clone();
    all.add_all_columns();
    assert_eq!(read(&all.get().await.expect("get").expect("a row"), "name"), Ok(OrmValue::Text("Ann".into())));
    let mut keys = first.clone();
    keys.remove_all_columns();
    let row = keys.get().await.expect("get").expect("a row");
    assert_eq!(read(&row, "seq"), Ok(int(1)), "the primary key stays");
    assert_eq!(read(&row, "email"), unselected("email"));
    let mut added = first.clone();
    added.remove_all_columns();
    added.add_column("name");
    let row = added.get().await.expect("get").expect("a row");
    assert_eq!(read(&row, "name"), Ok(OrmValue::Text("Ann".into())));
    assert_eq!(read(&row, "revision"), unselected("revision"));
    let mut removed = first.clone();
    removed.remove_column("email");
    let row = removed.get().await.expect("get").expect("a row");
    assert_eq!(read(&row, "email"), unselected("email"));
    assert_eq!(read(&row, "revision"), Ok(int(0)));
    for (member, call) in [("add_column", Query::add_column as fn(&mut Query, &str)), ("remove_column", Query::remove_column)] {
        let mut unknown = first.clone();
        call(&mut unknown, "missing");
        let error = failure(unknown.get().await, member);
        assert_eq!(error.to_string(), "config: missing is not a column of account", "{member}");
    }
    db.close().await;
}

/// The labels of the rows of the `relations` result `name` of `row`.
fn labels(row: &Query, name: &str) -> Option<Vec<OrmValue>> {
    row.related_rows(name).expect("related rows").map(|rows| rows.iter().map(|key| key.value("label").expect("label")).collect())
}

// Requirements: CORE-88. relations attaches the rows of a separate query by the key of match_pair under the name of
// alias, relation one row under <entity>_model, and a row reads them by related_rows and related.
#[tokio::test]
async fn relations_attach_the_rows_of_a_separate_query() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-query-relations");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let mut keys = Query::new(&schema, "account_key").expect("query");
    keys.match_pair("SeqWithAccountSeq");
    keys.order_by("SeqAsc");
    keys.alias("Keys");
    let mut accounts = query(&schema, "account", &db);
    accounts.order_by("SeqAsc");
    accounts.relations(keys);
    let rows = accounts.gets().await.expect("gets");
    let rows: Vec<&Query> = rows.models().collect();
    let k = |label: &str| OrmValue::Text(label.into());
    assert_eq!(labels(rows[0], "keys"), Some(vec![k("k1"), k("k2")]));
    assert_eq!(labels(rows[1], "keys"), Some(vec![k("k3")]));
    assert_eq!(labels(rows[2], "keys"), Some(vec![]), "an account without keys has an empty result");
    assert_eq!(labels(rows[0], "account_key_models"), None, "the alias names the result");
    let error = failure(rows[0].related("keys"), "a relations result read as one row");
    assert_eq!(error.kind(), crate::Kind::Internal, "{error}");

    let mut owner = Query::new(&schema, "account").expect("query");
    owner.match_pair("AccountSeqWithSeq");
    let mut key = query(&schema, "account_key", &db);
    key.where_chain("Seq", vec![int(3)]);
    key.relation(owner);
    let row = key.get().await.expect("get").expect("a row");
    let account = row.related("account_model").expect("related").expect("an account");
    assert_eq!(account.value("email").expect("email"), OrmValue::Text("b@x".into()));
    let error = failure(row.related_rows("account_model"), "a relation result read as rows");
    assert_eq!(error.kind(), crate::Kind::Internal, "{error}");
    db.close().await;
}

// Requirements: CORE-85, CORE-88. A child without match_pair is config, a pair that names no columns is config, and a
// child with a limit is limit_in_relation.
#[tokio::test]
async fn a_relation_child_needs_its_key_and_no_limit() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-query-relation-child");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let mut unmatched = query(&schema, "account", &db);
    unmatched.relations(Query::new(&schema, "account_key").expect("query"));
    let error = failure(unmatched.gets().await, "a child without match_pair");
    assert_eq!(error.to_string(), "config: relation child account_key requires match_<l>_with_<r>()");
    let mut pair = Query::new(&schema, "account_key").expect("query");
    pair.match_pair("SeqWithMissing");
    let mut paired = query(&schema, "account", &db);
    paired.relations(pair);
    let error = failure(paired.gets().await, "a pair that names no columns");
    assert_eq!(error.to_string(), "config: SeqWithMissing is not <column>With<column>");
    let mut limited = Query::new(&schema, "account_key").expect("query");
    limited.match_pair("SeqWithAccountSeq");
    limited.limit(0, 1);
    let mut parent = query(&schema, "account", &db);
    parent.relations(limited);
    let error = failure(parent.gets().await, "a child with a limit");
    assert_eq!(error.kind(), crate::Kind::LimitInRelation, "{error}");
    db.close().await;
}

// Requirements: CORE-86, CORE-88. A child of relations holds its own lock, which its own statement takes, as the
// retention reads its locked rows with the requests that reference them.
#[tokio::test]
async fn a_relation_child_holds_its_own_lock() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-query-relation-lock");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let child = |schema: &Schema| {
        let mut keys = Query::new(schema, "account_key").expect("query");
        keys.match_pair("SeqWithAccountSeq");
        keys.remove_all_columns();
        keys.for_share();
        keys.alias("keys");
        keys
    };
    let mut parent = Query::new(&schema, "account").expect("query");
    parent.for_update();
    parent.relations(child(&schema));
    let req = crate::request::build(&parent.core, "all");
    assert!(req.error().is_none(), "{:?}", req.error());
    assert_eq!(req.ir.query.lock, "update");
    assert_eq!(req.ir.query.relations[0].query.lock, "share", "the child keeps its own lock");
    let counts = db
        .transaction(
            |tx| {
                let schema = &schema;
                async move {
                    let mut accounts = Query::new(schema, "account")?;
                    accounts.connect(Connection::from(&tx));
                    accounts.order_by("SeqAsc");
                    accounts.for_update();
                    accounts.relations(child(schema));
                    let rows = accounts.gets().await?;
                    rows.models().map(|row| Ok(row.related_rows("keys")?.map_or(0, |keys| keys.len()))).collect::<Result<Vec<usize>>>()
                }
            },
            crate::TransactionOptions::default(),
        )
        .await
        .expect("a locked read with a locked relation");
    assert_eq!(counts, [2, 1, 0]);
    db.close().await;
}

// Requirements: CORE-89. key_name keys the collection of gets and the rows of a relations result by a column, and a
// name that is no column is config at the next terminal.
#[tokio::test]
async fn key_name_keys_the_rows_by_a_column() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-query-key-name");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let mut accounts = query(&schema, "account", &db);
    accounts.order_by("SeqAsc");
    let rows = accounts.gets().await.expect("gets");
    assert_eq!(rows.keys(), [crate::Key::I(1), crate::Key::I(2), crate::Key::I(3)], "the primary key by default");
    accounts.key_name("email");
    let rows = accounts.gets().await.expect("gets");
    assert_eq!(rows.keys(), ["a@x", "b@x", "c@x"].map(|email| crate::Key::S(email.into())));
    assert_eq!(rows.get(crate::Key::S("b@x".into())).map(|row| row.value("seq").expect("seq")), Some(int(2)));
    let mut keys = Query::new(&schema, "account_key").expect("query");
    keys.match_pair("SeqWithAccountSeq");
    keys.key_name("label");
    let mut parent = Query::new(&schema, "account").expect("query");
    parent.relations(keys);
    let req = crate::request::build(&parent.core, "all");
    assert_eq!(req.ir.query.relations[0].query.key_by, "label", "a relations result is keyed by the column");
    let mut unknown = query(&schema, "account", &db);
    unknown.key_name("missing");
    let error = failure(unknown.gets().await, "a name that is no column");
    assert_eq!(error.to_string(), "config: missing is not a column of account");
    db.close().await;
}

/// A subquery of the account of each key, which reads the column account_seq.
fn key_accounts(schema: &Schema) -> Query {
    let mut keys = Query::new(schema, "account_key").expect("query");
    keys.remove_all_columns();
    keys.add_column("account_seq");
    keys
}

// Requirements: CORE-90. where_in compares a column with the rows of a subquery, Ne negates it, a connector at the
// start of the name joins it to the conditions before it, and a chain of another operator or key count is config.
#[tokio::test]
async fn where_in_compares_a_column_with_a_subquery() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-query-where-in");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let mut with_keys = query(&schema, "account", &db);
    with_keys.order_by("SeqAsc");
    with_keys.where_in("Seq", key_accounts(&schema));
    assert_eq!(seqs(&with_keys.gets().await.expect("gets")), [int(1), int(2)], "the accounts that a key references");
    let mut without = query(&schema, "account", &db);
    without.where_in("NeSeq", key_accounts(&schema));
    assert_eq!(seqs(&without.gets().await.expect("gets")), [int(3)], "the account that no key references");
    let mut joined = query(&schema, "account", &db);
    joined.where_chain("Seq", vec![int(3)]);
    joined.where_in("OrSeq", key_accounts(&schema));
    assert_eq!(joined.get_count().await.expect("count"), 3, "seq = 3 or seq in the subquery");
    for (chain, message) in [
        ("GtSeq", "config: a subquery is not accepted by the gt operator"),
        ("SeqAndEmail", "config: the condition expects 2 values"),
        ("Missing", "config: Missing is not a column of account"),
    ] {
        let mut refused = query(&schema, "account", &db);
        refused.where_in(chain, key_accounts(&schema));
        let error = failure(refused.get_count().await, chain);
        assert_eq!(error.to_string(), message, "chain {chain}");
    }
    db.close().await;
}

// Requirements: CORE-90. A subquery reads one column added with add_column and takes no limit, lock, relation or
// connection of its own.
#[tokio::test]
async fn a_subquery_reads_one_column_and_nothing_else() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-query-subquery");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let mut no_column = Query::new(&schema, "account_key").expect("query");
    no_column.remove_all_columns();
    let mut limited = key_accounts(&schema);
    limited.limit(0, 1);
    let mut locked = key_accounts(&schema);
    locked.for_share();
    let mut related = key_accounts(&schema);
    let mut owner = Query::new(&schema, "account").expect("query");
    owner.match_pair("AccountSeqWithSeq");
    related.relation(owner);
    let mut connected = key_accounts(&schema);
    connected.connect(Connection::from(&db));
    for (what, sub, message) in [
        ("no column", no_column, "config: a subquery model must add exactly one column with add_column_<col>()"),
        ("a limit", limited, "ir_invalid: subquery may not use limit, relations, lock or columns"),
        ("a lock", locked, "ir_invalid: subquery may not use limit, relations, lock or columns"),
        ("a relation", related, "config: a subquery model cannot load relations"),
        ("a connection", connected, "config: a subquery model cannot have its own connection"),
    ] {
        let mut outer = query(&schema, "account", &db);
        outer.where_in("Seq", sub);
        let error = failure(outer.get_count().await, what);
        assert_eq!(error.to_string(), message, "a subquery with {what}");
    }
    db.close().await;
}

/// The account of `seq`, read with every column.
async fn account(schema: &Schema, db: &Db, seq: i64) -> Option<Query> {
    let mut account = query(schema, "account", db);
    account.where_chain("Seq", vec![int(seq)]);
    account.add_all_columns();
    account.get().await.expect("get")
}

// Requirements: CORE-91. create inserts the row of the assignments and returns it with its identity, and a row that a
// unique key refuses fails with duplicate_key.
#[tokio::test]
async fn create_inserts_the_row_of_the_assignments() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-query-create");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let mut new = query(&schema, "account", &db);
    new.set("email", OrmValue::Text("d@x".into()));
    new.set("name", OrmValue::Null);
    new.set("revision", int(0));
    let created = new.create().await.expect("create");
    assert_eq!(created.value("seq").expect("seq"), int(4), "the identity of the new row");
    assert_eq!(created.value("email").expect("email"), OrmValue::Text("d@x".into()));
    assert_eq!(account(&schema, &db, 4).await.map(|row| row.value("email").expect("email")), Some(OrmValue::Text("d@x".into())));
    let mut duplicate = query(&schema, "account", &db);
    duplicate.set("email", OrmValue::Text("a@x".into()));
    duplicate.set("revision", int(0));
    let error = failure(duplicate.create().await, "a second a@x");
    assert_eq!(error.kind(), crate::Kind::DuplicateKey, "{error}");
    let error = failure(query(&schema, "account", &db).create().await, "no assignment");
    assert_eq!(error.to_string(), "config: create requires set_<col> values");
    db.close().await;
}

// Requirements: CORE-91. update writes the assignments to the row that the query read or to the row of the primary key
// that set assigned, and expect_revision writes only while the column holds the revision.
#[tokio::test]
async fn update_writes_the_assignments_to_its_row() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-query-update");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let name = |row: Option<Query>| row.expect("a row").value("name").expect("name");
    let mut loaded = account(&schema, &db, 2).await.expect("account 2");
    loaded.set("name", OrmValue::Text("Bea".into()));
    loaded.update().await.expect("update a read row");
    assert_eq!(name(account(&schema, &db, 2).await), OrmValue::Text("Bea".into()));
    let mut keyed = query(&schema, "account", &db);
    keyed.set("seq", int(1));
    keyed.set("name", OrmValue::Text("Zed".into()));
    keyed.update().await.expect("update by a set primary key");
    assert_eq!(name(account(&schema, &db, 1).await), OrmValue::Text("Zed".into()));
    let mut keyless = query(&schema, "account", &db);
    keyless.set("name", OrmValue::Text("Nobody".into()));
    let error = failure(keyless.update().await, "no row and no key");
    assert_eq!(error.to_string(), "config: account requires a loaded row or a set primary key seq");
    let mut stale = account(&schema, &db, 3).await.expect("account 3");
    stale.set("name", OrmValue::Text("Cy".into()));
    stale.expect_revision("revision", 5);
    let error = failure(stale.update().await, "a revision that the row does not hold");
    assert_eq!(error.kind(), crate::Kind::RevisionChanged, "{error}");
    let mut fresh = account(&schema, &db, 3).await.expect("account 3");
    fresh.set("name", OrmValue::Text("Cy".into()));
    fresh.expect_revision("revision", 0);
    fresh.update().await.expect("the revision that the row holds");
    let row = account(&schema, &db, 3).await.expect("account 3");
    assert_eq!((row.value("name").expect("name"), row.value("revision").expect("revision")), (OrmValue::Text("Cy".into()), int(1)));
    db.close().await;
}

// Requirements: CORE-91. set refuses a name that is no column and a value that no column takes.
#[tokio::test]
async fn set_refuses_what_no_column_takes() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-query-set");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    for (column, value, message) in [
        ("missing", OrmValue::Text("x".into()), "config: missing is not a column of account"),
        ("email", OrmValue::List(vec![]), "codec_encode: the value of a column is a list"),
        ("email", OrmValue::Map(indexmap::IndexMap::new()), "codec_encode: the value of a column is a map"),
    ] {
        let mut new = query(&schema, "account", &db);
        new.set("revision", int(0));
        new.set(column, value);
        let error = failure(new.create().await, column);
        assert_eq!(error.to_string(), message, "set {column}");
    }
    db.close().await;
}

// Requirements: CORE-91. delete deletes the row that the query read or the row of a set primary key, and a collection
// of rows deletes each of them.
#[tokio::test]
async fn delete_deletes_its_row() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-query-delete");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    account(&schema, &db, 3).await.expect("account 3").delete().await.expect("delete a read row");
    assert!(account(&schema, &db, 3).await.is_none());
    let mut keyed = query(&schema, "account_key", &db);
    keyed.set("seq", int(3));
    keyed.delete().await.expect("delete by a set primary key");
    let mut keys = query(&schema, "account_key", &db);
    keys.where_chain("AccountSeq", vec![int(1)]);
    keys.gets().await.expect("gets").delete(false).await.expect("delete the rows of a collection");
    assert_eq!(query(&schema, "account_key", &db).get_count().await.expect("count"), 0);
    db.close().await;
}

/// One table with a `soft_delete` setting and a unique email.
pub(super) const MEMBER: &str = "dbspec 1 member

table member {
  seq i64 identity
  email varchar(64)
  name varchar(32) null
  deleted_at datetime(6) null
  primary key (seq)
  unique uq_member_email (email)
  settings {
    soft_delete deleted_at
  }
}
";
pub(super) const MEMBER_HASH: &str = "sha256:a6fa9270b90b482529da0479be752f4efdf6c9db3ebaae877822af5329dd0660";

/// A SQLite database with the member table, the member 1 (`a@x`), which is not deleted, and the member 2 (`b@x`),
/// which is soft-deleted.
async fn member_db(scratch: &Scratch, schema: &Schema) -> Db {
    let db = Db::connect(&format!("sqlite://{}", scratch.join("member.sqlite").display()), 1, Config::default()).await.expect("connect");
    db.utils().schema().install(schema).await.expect("install");
    for (email, name) in [("a@x", "Ann"), ("b@x", "Bob")] {
        let mut new = query(schema, "member", &db);
        new.set("email", OrmValue::Text(email.into()));
        new.set("name", OrmValue::Text(name.into()));
        new.create().await.expect("create a member");
    }
    let mut bob = query(schema, "member", &db);
    bob.set("seq", int(2));
    bob.delete().await.expect("soft-delete the member 2");
    db
}

fn by_email(schema: &Schema, db: &Db, email: &str) -> Query {
    let mut member = query(schema, "member", db);
    member.set("email", OrmValue::Text(email.into()));
    member
}

async fn member_count(schema: &Schema, db: &Db) -> i64 {
    query(schema, "member", db).get_count().await.expect("count")
}

// Requirements: CORE-94. restore restores the soft-deleted row of the key of the assignments, writes the other
// assignments to it and returns it; a row of the key that is not deleted is returned and not written, no row of the key
// is no_rows, and an entity without soft_delete is ir_invalid.
#[tokio::test]
async fn restore_restores_the_soft_deleted_row_of_its_key() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-query-restore");
    let schema = Schema::load(MEMBER, "", MEMBER_HASH).expect("the member schema loads");
    let db = member_db(&scratch, &schema).await;
    assert_eq!(member_count(&schema, &db).await, 1, "a read does not return the soft-deleted member");
    let mut deleted = by_email(&schema, &db, "b@x");
    deleted.set("name", OrmValue::Text("Bea".into()));
    let restored = deleted.restore().await.expect("restore");
    assert_eq!(restored.value("seq").expect("seq"), int(2));
    assert_eq!(restored.value("name").expect("name"), OrmValue::Text("Bea".into()), "the assignment that is no key is written");
    assert_eq!(member_count(&schema, &db).await, 2);
    let error = failure(deleted.restore().await, "a restore after the assignments were cleared");
    assert_eq!(error.kind(), crate::Kind::IrInvalid, "restore clears the assignments, so the next request holds no key: {error}");
    let mut live = by_email(&schema, &db, "a@x");
    live.set("name", OrmValue::Text("Amy".into()));
    let unchanged = live.restore().await.expect("restore of a row that is not deleted");
    assert_eq!(unchanged.value("name").expect("name"), OrmValue::Text("Ann".into()), "a row that is not deleted is not written");
    let error = failure(by_email(&schema, &db, "z@x").restore().await, "no row of the key");
    assert_eq!(error.kind(), crate::Kind::NoRows, "{error}");
    db.close().await;
    let accounts = account_schema();
    let account_db = account_db(&scratch, &accounts).await;
    let mut account = query(&accounts, "account", &account_db);
    account.set("email", OrmValue::Text("a@x".into()));
    let error = failure(account.restore().await, "an entity without soft_delete");
    assert_eq!(error.kind(), crate::Kind::IrInvalid, "{error}");
    account_db.close().await;
}

// Requirements: CORE-94. restore_or_create restores the soft-deleted row of the key or inserts the row of the
// assignments when no row holds the key, and a row of the key that is not deleted is row_not_deleted with nothing
// written.
#[tokio::test]
async fn restore_or_create_restores_or_inserts_the_row() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-query-restore-or-create");
    let schema = Schema::load(MEMBER, "", MEMBER_HASH).expect("the member schema loads");
    let db = member_db(&scratch, &schema).await;
    let restored = by_email(&schema, &db, "b@x").restore_or_create().await.expect("restore the member 2");
    assert_eq!(restored.value("seq").expect("seq"), int(2));
    let mut new = by_email(&schema, &db, "c@x");
    new.set("name", OrmValue::Text("Cy".into()));
    let created = new.restore_or_create().await.expect("create the member 3");
    assert_eq!(created.value("seq").expect("seq"), int(3));
    assert_eq!(created.value("name").expect("name"), OrmValue::Text("Cy".into()));
    assert_eq!(member_count(&schema, &db).await, 3);
    let error = failure(new.restore_or_create().await, "a second call after the assignments were cleared");
    assert_eq!(error.kind(), crate::Kind::IrInvalid, "restore_or_create clears the assignments: {error}");
    let mut live = by_email(&schema, &db, "a@x");
    live.set("name", OrmValue::Text("Amy".into()));
    let error = failure(live.restore_or_create().await, "a row of the key that is not deleted");
    assert_eq!(error.kind(), crate::Kind::RowNotDeleted, "{error}");
    let mut read = query(&schema, "member", &db);
    read.where_chain("Email", vec![OrmValue::Text("a@x".into())]);
    assert_eq!(read.get().await.expect("get").expect("member 1").value("name").expect("name"), OrmValue::Text("Ann".into()), "nothing is written");
    db.close().await;
}

// Requirements: CORE-120. to_array holds the columns that the row read in the order of the schema: a column that was
// not read has no key, a null column has its key, and a query that read no row holds nothing.
#[tokio::test]
async fn to_array_holds_the_columns_that_the_row_read() {
    let _case = polyspec_orm_testcase::case!();
    let scratch = Scratch::new("orm-rust-query-to-array");
    let schema = account_schema();
    let db = account_db(&scratch, &schema).await;
    let pairs = |row: &Query| row.to_array().expect("to_array").into_iter().collect::<Vec<_>>();
    let text = |value: &str| OrmValue::Text(value.into());
    let mut third = query(&schema, "account", &db);
    third.where_chain("Seq", vec![int(3)]);
    assert_eq!(pairs(&third), Vec::new(), "a query that read no row");
    let row = third.get().await.expect("get").expect("a row");
    assert_eq!(
        pairs(&row),
        vec![("seq".to_owned(), int(3)), ("email".to_owned(), text("c@x")), ("revision".to_owned(), int(0))],
        "select explicit leaves name out, so the map has no key of it"
    );
    let mut all = third.clone();
    all.add_all_columns();
    let row = all.get().await.expect("get").expect("a row");
    assert_eq!(
        pairs(&row),
        vec![("seq".to_owned(), int(3)), ("email".to_owned(), text("c@x")), ("name".to_owned(), OrmValue::Null), ("revision".to_owned(), int(0))],
        "a null column has its key, in the order of the schema"
    );
    let mut keyed = third.clone();
    keyed.remove_all_columns();
    keyed.add_column("revision");
    let row = keyed.get().await.expect("get").expect("a row");
    assert_eq!(pairs(&row), vec![("seq".to_owned(), int(3)), ("revision".to_owned(), int(0))]);
    db.close().await;
}
