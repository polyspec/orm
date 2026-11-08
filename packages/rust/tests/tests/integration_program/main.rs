//! Generated model integration test on SQLite, MySQL and PostgreSQL. Each
//! case runs in a case database of its own (polyspec-orm-case-database), created on
//! the servers of ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN and dropped when
//! the case ends; the test fails when either is unset.
//!
//! Each section is one test that runs its case on every driver, in case databases of its own, so the sections run in parallel.
//! The workspace cargo test of the rust lane of scripts/client-db-test.mts runs them, scripts/case-database-check.mts runs the
//! target, and make feature-rust-unit runs one section.
use polyspec_orm_testcase::OrPanic;
use polyspec_orm_tests::plain::Plain;

#[path = "../common/result_code.rs"]
mod result_code;
use result_code::code;

polyspec_orm::models!();

#[test]
// Requirements: DBS-112, DBS-114.
fn generated_typed_getter_is_a_checked_public_consumer_api() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);

    fn read_seq(row: &Author) -> polyspec_orm::Result<i64> {
        row.get_seq()
    }

    let unselected = Author::new();
    let error = read_seq(&unselected).expect_err("an unselected generated field must fail");
    assert_eq!(error.code(), polyspec_orm::codes::COLUMN_UNSELECTED);

    let assigned = Author::new().set_seq(17);
    let sequence: i64 = read_seq(&assigned).expect("an assigned generated field is readable");
    assert_eq!(sequence, 17);
}

mod bench_set;

#[allow(
    dead_code,
    unused_imports,
    clippy::all,
    reason = "the generated models are included whole, a crate uses only some of them, and lints of hand-written code do not apply to generated code"
)]
mod nonnull_model {
    include!(concat!(env!("OUT_DIR"), "/nonnull/orm_model.rs"));
}

#[allow(
    dead_code,
    unused_imports,
    clippy::all,
    reason = "the generated models are included whole, a crate uses only some of them, and lints of hand-written code do not apply to generated code"
)]
mod external_member {
    include!(concat!(env!("OUT_DIR"), "/external/orm_model.rs"));
}

/// A relation to an entity of a used external document is a relation to an entity of the set: its getter returns the model of that
/// entity, which the member set generates, and a row without a related row reads no error and no model.
#[test]
fn external_relation_getter_returns_the_external_entity_model() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::COMPUTE);
    let row = external_member::ExtPost::new();
    let audit: polyspec_orm::Result<Option<&external_member::ExtAudit>> = row.get_ext_audit_model();
    assert!(audit.expect("a row without a related row reads no error").is_none());
}

/// The generated schema value carries the external text at run time: the generated connect registers a set that uses an
/// external document, and the model of a used external table reads a row of that table.
#[tokio::test]
// Requirements: DBS-110, DBS-173.
async fn generated_external_model_reads_its_table() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let database = CaseDatabase::create("sqlite").await;
    let db = external_member::connect(database.dsn(), TARGET_POOL_SIZE, config()).await.or_panic(|e| format!("connect: {e}"));
    let Pool::Sqlite(pool) = db.pool() else { unreachable!("the DSN selects SQLite") };
    sqlx::query("CREATE TABLE ext_account (seq INTEGER PRIMARY KEY, name TEXT NOT NULL)").execute(pool).await.or_panic(|e| format!("create: {e}"));
    sqlx::query("INSERT INTO ext_account (seq, name) VALUES (1, 'kim')").execute(pool).await.or_panic(|e| format!("insert: {e}"));
    let row = external_member::ExtAccount::new().connect(&db).get_by_seq(1).await.or_panic(|e| format!("read: {e}")).expect("a row");
    assert_eq!(row.get_name().unwrap(), "kim");
    db.close().await;
    database.drop().await;
}

#[test]
// Requirements: COD-20, COD-25.
fn generated_nonnull_styled_setter_rejects_sql_null() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let err = match nonnull_model::NonnullDocument::new().set_body(polyspec_orm::StyledValue::SqlNull) {
        Ok(_) => panic!("non-null styled setter accepted SQL NULL"),
        Err(err) => err,
    };
    assert_eq!(err.code(), polyspec_orm::codes::CODEC_ENCODE);
    let value = polyspec_orm::ordered_json::Value::null();
    let row = match nonnull_model::NonnullDocument::new().set_body(polyspec_orm::StyledValue::Value(value.clone())) {
        Ok(row) => row,
        Err(err) => panic!("JSON null must be an encoded value: {err}"),
    };
    let got = match row.get_body() {
        Ok(value) => value,
        Err(err) => panic!("assigned value must be readable: {err}"),
    };
    match got {
        polyspec_orm::StyledValue::Value(got) => assert_eq!(got.compact(), value.compact()),
        polyspec_orm::StyledValue::SqlNull => panic!("encoded JSON null became SQL NULL"),
    }
}

use model::{Account, Author, CompositeAccount, CompositeMembership, Service, ServiceMember, ServiceRegion, User};
use polyspec_orm::db::Pool;
use polyspec_orm::{Collection, Db, Null};
use polyspec_orm_case_database::CaseDatabase;

const TARGET_POOL_SIZE: u32 = 4;

struct Target {
    driver: &'static str,
    dsn: String,
    db: Db,
    database: CaseDatabase,
    _wait: NamesItsWait,
}

/// What a connection of `driver` waits on: the acquire timeout of its pool, 30 s, the default of SQLx that
/// packages/rust/orm/src/db.rs does not change, and through ProxySQL, when ORM_TEST_MYSQL_DSN is not the server, hostgroup 0, the
/// default_hostgroup of the user orm in scripts/test-servers.mts, within mysql-connect_timeout_server_max, whose 10000 ms ProxySQL
/// reports in its error 9001.
fn waits_on(driver: &str) -> String {
    let pool = "the pool acquire timeout of 30 s";
    if driver == "mysql" && std::env::var_os("ORM_TEST_MYSQL_DSN") != std::env::var_os("ORM_TEST_MYSQL_SERVER_DSN") {
        format!("ProxySQL hostgroup 0 within mysql-connect_timeout_server_max 10000 ms, and {pool}")
    } else {
        pool.to_owned()
    }
}

/// Names what its case waited on when the case panics, since any statement of the case can end on a connection wait.
struct NamesItsWait(&'static str);

impl Drop for NamesItsWait {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!("{}: this case waits for a connection on {}", self.0, waits_on(self.0));
        }
    }
}

fn config() -> polyspec_orm::Config {
    polyspec_orm::Config { aes_key: "test-aes-key".into(), blind_index_key: "test-blind-key".into(), ..Default::default() }
}

#[test]
// Requirements: DBS-114.
fn generated_fields_require_selection_or_assignment() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let model = Author::new();
    assert_eq!(model.get_name().unwrap_err().code(), polyspec_orm::codes::COLUMN_UNSELECTED);
    assert_eq!(model.clone().set_name("assigned").get_name().unwrap(), "assigned");
    assert_eq!(model.set_name("checked").get_name().unwrap(), "checked");
}

impl Target {
    /// Connects to a new case database for `driver` and installs the schema twice (the second install
    /// changes nothing).
    async fn installed(driver: &str) -> Target {
        let t = Target::empty(driver).await;
        bench_set::install(&t.db).await.or_panic(|e| format!("{}: schema().install: {e}", t.driver));
        bench_set::install(&t.db).await.or_panic(|e| format!("{}: schema().install again: {e}", t.driver));
        t
    }

    /// Connects to a new case database for `driver` (MySQL, PostgreSQL) or a new SQLite file.
    async fn empty(driver: &str) -> Target {
        let database = CaseDatabase::create(driver).await;
        let dsn = if driver == "sqlite" { format!("{}?_pragma=busy_timeout(5000)", database.dsn()) } else { database.dsn().to_owned() };
        let db = model::connect(&dsn, TARGET_POOL_SIZE, config()).await.or_panic(|e| format!("{driver}: {e}; waited on {}", waits_on(driver)));
        Target { driver: database.driver(), dsn, db, _wait: NamesItsWait(database.driver()), database }
    }

    /// Closes the connection and drops the case database.
    async fn finish(self) {
        self.db.close().await;
        self.database.drop().await;
    }
}

struct Fixture {
    service: Service,
    member: ServiceMember,
    users: Vec<User>,
    authors: Vec<Author>,
}

fn start() -> chrono::NaiveDateTime {
    chrono::NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(3, 4, 5).unwrap()
}

async fn seed(db: &Db) -> Fixture {
    let service = Service::new().connect(db).set_name("service").create().await.unwrap();
    let mut users = Vec::new();
    for name in ["kim", "lee", "park"] {
        users.push(User::new().connect(db).set_name(name).create().await.unwrap());
    }
    let module = ServiceRegion::new().connect(db).set_service_seq(service.get_seq().unwrap()).set_name("module").create().await.unwrap();
    let member = ServiceMember::new().connect(db).set_service_seq(service.get_seq().unwrap()).set_user_seq(users[0].get_seq().unwrap()).create().await.unwrap();
    let mut authors = Vec::new();
    for (i, name) in ["alpha", "beta", "gamma", "delta"].into_iter().enumerate() {
        let i = i as i64;
        let mut b = Author::new()
            .connect(db)
            .set_name(name)
            .set_user_seq(users[(i % 2) as usize].get_seq().unwrap())
            .set_service_seq(service.get_seq().unwrap())
            .set_service_region_seq(module.get_seq().unwrap())
            .set_service_member_seq(member.get_seq().unwrap())
            .set_start_dt(txt(start() + chrono::Duration::hours(i)))
            .unwrap()
            .set_end_dt(txt(start() + chrono::Duration::hours(48)))
            .unwrap()
            .set_read_count(i as i32 * 10)
            .set_is_close(i % 2 == 1);
        if i < 2 {
            b = b.set_photo_url(format!("cover-{name}"));
        }
        authors.push(b.create().await.unwrap());
    }
    Fixture { service, member, users, authors }
}

fn names(c: &Collection<Author>) -> String {
    c.models().map(|b| b.get_name().unwrap().to_owned()).collect::<Vec<_>>().join(",")
}

// Requirements: DSL-60, PLN-6, PLN-7, PLN-23, PLN-28, PLN-34, PLN-37, PLN-38, PLN-39.
async fn conditions_case(t: &Target) {
    let db = &t.db;
    let f = seed(db).await;
    let svc = f.service.get_seq().unwrap();
    let rows = Author::new().connect(db).service_seq(svc).and_is_close(false).or(()).is_close(true).order_by_seq_asc().gets().await.unwrap();
    assert_eq!(names(&rows), "alpha,beta,gamma,delta", "connectors");
    let rows = Author::new()
        .connect(db)
        .service_seq(svc)
        .and(|q: Author| q.ge_read_count(10).and_lt_read_count(30).or(()).name("alpha"))
        .order_by_read_count_desc_and_seq_asc()
        .gets()
        .await
        .unwrap();
    assert_eq!(names(&rows), "gamma,beta,alpha", "group");
    let rows = Author::new().connect(db).gets_by_seq_and_ne_name(vec![f.authors[0].get_seq().unwrap(), f.authors[1].get_seq().unwrap()], "beta").await.unwrap();
    assert_eq!(names(&rows), "alpha", "gets_by list");
    assert_eq!(Author::new().connect(db).photo_url(Null).get_count().await.unwrap(), 2, "null");
    assert_eq!(Author::new().connect(db).ne_photo_url(Null).and_lk_name("lph").get_count().await.unwrap(), 1, "not null and like");
    assert_eq!(Author::new().connect(db).between_read_count([10, 20]).get_count().await.unwrap(), 2, "between");
    assert_eq!(Author::new().connect(db).gt_start_dt(txt(start() + chrono::Duration::minutes(90))).get_count().await.unwrap(), 2, "time compare");
    let one = Author::new().connect(db).get_by_name("gamma").await.unwrap().expect("a row");
    assert_eq!(one.get_read_count().unwrap(), 20, "get_by");
    assert!(Author::new().connect(db).get_by_name("missing").await.unwrap().is_none(), "get without a row");
    let q = Author::new().connect(db).service_seq(svc);
    let first = q.get_count_by_is_close(true).await.unwrap();
    let second = q.get_count().await.unwrap();
    assert_eq!((first, second), (2, 4), "a terminal changed the model");
    assert_eq!(Author::new().connect(db).ge_read_count(20).get_count().await.unwrap(), 2, "ge");
    assert_eq!(code(Author::new().connect(db).name("a").is_close(true).gets().await), "CONFIG", "missing connector");
    assert_eq!(code(Author::new().connect(db).name("a").and(()).gets().await), "CONFIG", "dangling connector");
    assert_eq!(code(Author::new().connect(db).seq(Vec::<i64>::new()).gets().await), "EMPTY_IN", "empty list");
    let stmt = Author::new().connect(db).name("alpha").get_query().await.unwrap();
    assert!(stmt.sql.contains("name") && stmt.binds.len() == 1, "get_query: {} {:?}", stmt.sql, stmt.binds);
    assert_eq!(code(Author::new().name("alpha").gets().await), "CONFIG", "no connection");
}

// Requirements: PLN-8, PLN-9, PLN-14.
async fn columns_and_subqueries_case(t: &Target) {
    let db = &t.db;
    let f = seed(db).await;
    let users = User::new()
        .connect(db)
        .add_column_read_total(|u: &User| Author::new().sum_read_count().user_seq_eq_seq(u))
        .seq(Author::new().add_column_user_seq().is_close(false))
        .order_by_seq_asc()
        .gets()
        .await
        .unwrap();
    assert_eq!(users.len(), 1, "subquery IN");
    let u = users.first().unwrap();
    let int = |v: Option<serde_json::Value>| -> Result<i64, String> {
        let value = v.ok_or_else(|| "computed integer is absent".to_owned())?;
        match value {
            serde_json::Value::Number(number) if number.is_i64() => number.as_i64().ok_or_else(|| "signed integer is out of range".to_owned()),
            serde_json::Value::Number(number) if number.is_u64() => {
                i64::try_from(number.as_u64().ok_or_else(|| "unsigned integer is invalid".to_owned())?).map_err(|error| error.to_string())
            }
            serde_json::Value::Number(number) => {
                let float = number.as_f64().ok_or_else(|| "numeric value is invalid".to_owned())?;
                if !float.is_finite() || float.fract() != 0.0 || !(-9_007_199_254_740_992.0..=9_007_199_254_740_992.0).contains(&float) {
                    return Err(format!("numeric value is not an i64: {number}"));
                }
                Ok(float as i64)
            }
            serde_json::Value::String(text) => text.parse::<i64>().map_err(|error| error.to_string()),
            other => Err(format!("computed integer has an invalid type: {other}")),
        }
    };
    assert_eq!(int(u.get_read_total().unwrap()).expect("subquery integer"), 20, "subquery column");
    let sum = Author::new().connect(db).service_seq(f.service.get_seq().unwrap()).sum_read_count().get_sum().await.unwrap();
    let avg = Author::new().connect(db).service_seq(f.service.get_seq().unwrap()).avg_read_count().get_avg().await.unwrap();
    assert_eq!((sum, avg), (60.0, Some(15.0)), "aggregates");
    let projected = Author::new().connect(db).remove_all_columns().add_column_name().get_by_seq(f.authors[0].get_seq().unwrap()).await.unwrap().expect("a row");
    assert_eq!(projected.get_name().unwrap(), "alpha", "selected field");
    assert_eq!(projected.get_description().unwrap_err().code(), polyspec_orm::codes::COLUMN_UNSELECTED, "unselected field");
    let grouped = Author::new().connect(db).group_by_is_close().gets_count().await.unwrap();
    assert_eq!(grouped.len(), 2, "gets_count");
    for row in grouped.iter() {
        assert!(row.count() > 0);
        assert!(matches!(row.value("is_close").unwrap(), polyspec_orm::Val::Bool(_)));
        assert_eq!(row.value("name").unwrap_err().code(), polyspec_orm::codes::COLUMN_UNSELECTED);
    }
    let page = Author::new().connect(db).order_by_seq_asc().gets_page(2, 3).await.unwrap();
    assert_eq!((page.total_count, page.total_pages, page.items.len()), (4, 2, 1), "page");
    assert_eq!(page.items.first().map(|b| b.get_name().unwrap()), Some("delta"), "page item");
    let keyed = Author::new().connect(db).key_name_name().gets().await.unwrap();
    assert!(keyed.get("beta").is_some(), "key_name");
    let fetched = Author::new()
        .connect(db)
        .fetch_key(|b: &Author| b.get_read_count().unwrap())
        .fetch_value(|b: &Author| serde_json::json!(b.get_name().unwrap().len()))
        .gets()
        .await
        .unwrap();
    assert_eq!(fetched.fetched_value(20).cloned(), Some(serde_json::json!(5)), "fetch_key and fetch_value");
    for account in [10, 11] {
        for tenant in [1, 2] {
            CompositeAccount::new().connect(db).set_tenant_id(tenant).set_account_id(account).set_name("n").create().await.unwrap();
        }
    }
    let memberships = vec![
        CompositeMembership::new().set_tenant_id(1).set_account_id(10).set_role("owner"),
        CompositeMembership::new().set_tenant_id(1).set_account_id(11).set_role("member"),
        CompositeMembership::new().set_tenant_id(2).set_account_id(10).set_role("member"),
    ];
    assert_eq!(CompositeMembership::new().connect(db).creates(memberships, 3).await.unwrap(), 3, "creates");
    let pairs = CompositeMembership::new().connect(db).tuple_tenant_id_with_account_id(vec![(1, 10), (2, 10)]).get_count().await.unwrap();
    assert_eq!(pairs, 2, "tuple");
}

// Requirements: DSL-115, DSL-155, PLN-12, PLN-27.
async fn writes_case(t: &Target) {
    let db = &t.db;
    let f = seed(db).await;
    let b = Author::new().connect(db).get_by_seq(f.authors[0].get_seq().unwrap()).await.unwrap().expect("a row");
    let mut b = b.set_name("renamed").plus_read_count(5);
    b.update(true).await.unwrap();
    let again = Author::new().connect(db).get_by_seq(b.get_seq().unwrap()).await.unwrap().expect("a row");
    assert_eq!((again.get_name().unwrap(), again.get_read_count().unwrap()), ("renamed", 5), "update");
    let mut b = b.set_name("stale");
    assert_eq!(code(b.update(true).await), "CONFIG", "optimistic update without a fresh version");
    let mut again = again.set_name("again");
    again.update(false).await.unwrap();
    let mut b = b.set_name("x");
    b.update(false).await.unwrap();
    let item = Account::new().connect(db).set_name("acc").new_label("shown").create().await.unwrap();
    assert_eq!(item.get_label().unwrap(), Some(serde_json::json!("shown")), "new value");
    assert_eq!(item.to_array().unwrap().plain().unwrap()["label"], "shown", "new value output");
    let saved = Account::new().connect(db).set_seq(item.get_seq().unwrap()).set_name("saved").save().await.unwrap();
    assert_eq!(saved.get_name().unwrap(), "saved", "save result");
    let stored = Account::new().connect(db).get_by_seq(item.get_seq().unwrap()).await.unwrap().expect("a row");
    assert_eq!(stored.get_name().unwrap(), "saved", "save as update");
    Author::new().connect(db).get_by_seq(f.authors[3].get_seq().unwrap()).await.unwrap().expect("a row").delete(false).await.unwrap();
    assert_eq!(Author::new().connect(db).get_count().await.unwrap(), 3, "delete");
    let rows = Author::new().connect(db).is_close(true).gets().await.unwrap();
    rows.delete(false).await.unwrap();
    assert_eq!(Author::new().connect(db).get_count().await.unwrap(), 2, "collection delete");
    CompositeAccount::new().connect(db).set_tenant_id(9).set_account_id(9).set_name("first").create().await.unwrap();
    CompositeAccount::new()
        .connect(db)
        .set_tenant_id(9)
        .set_account_id(9)
        .set_name("first")
        .duplication(CompositeAccount::new().set_name("second"))
        .create()
        .await
        .unwrap();
    let got = CompositeAccount::new().connect(db).get_by_tenant_id_and_account_id(9, 9).await.unwrap().expect("a row");
    assert_eq!(got.get_name().unwrap(), "second", "duplication");
    let service = Service::new().connect(db).set_name("tree").create().await.unwrap();
    ServiceMember::new().connect(db).set_service_seq(service.get_seq().unwrap()).set_user_seq(f.users[1].get_seq().unwrap()).create().await.unwrap();
    let tree = Service::new()
        .connect(db)
        .relations(ServiceMember::new().match_seq_with_service_seq())
        .get_by_seq(service.get_seq().unwrap())
        .await
        .unwrap()
        .expect("a row");
    tree.delete(true).await.unwrap();
    assert_eq!(ServiceMember::new().connect(db).get_count_by_service_seq(service.get_seq().unwrap()).await.unwrap(), 0, "recursive delete");
    let copy = Service::new().connect(db).get_by_seq(f.service.get_seq().unwrap()).await.unwrap().expect("a row");
    let json = serde_json::to_value(&copy).unwrap();
    assert_eq!(json["name"], "service", "serialize");
}

/// Returns after the replica has applied every change the primary committed
/// before the call. On PostgreSQL a transaction with
/// synchronous_commit=remote_apply that writes WAL, here a transactional
/// logical message, commits after the standby has applied it; a transaction
/// that writes no WAL besides its commit record does not wait. On MySQL
/// SOURCE_POS_WAIT on the replica waits for the binary log position of the
/// primary.
async fn await_replica(primary: &Db, replica: &Db) {
    use sqlx::Row;
    match (primary.pool(), replica.pool()) {
        (Pool::Postgres(p), _) => {
            let mut tx = p.begin().await.unwrap();
            sqlx::raw_sql("SET LOCAL synchronous_commit = remote_apply").execute(&mut *tx).await.unwrap();
            let row = sqlx::raw_sql("SELECT current_setting('synchronous_commit'), pg_logical_emit_message(true, 'orm-test-barrier', '')::text")
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            assert_eq!(row.get::<String, _>(0), "remote_apply", "synchronous_commit of the barrier transaction");
            tx.commit().await.unwrap();
        }
        (Pool::MySql(p), Pool::MySql(r)) => {
            let status = sqlx::raw_sql("SHOW BINARY LOG STATUS").fetch_one(p).await.unwrap();
            let (file, position): (String, u64) = (status.get(0), status.get(1));
            // The deadline is 60 seconds: a replica applies the writes of all clients running in parallel one by one, so on a 4-vCPU Linux
            // runner it could not reach the primary within 10 seconds.
            let waited: Option<i64> = sqlx::query_scalar("SELECT SOURCE_POS_WAIT(?, ?, 60)").bind(&file).bind(position).fetch_one(r).await.unwrap();
            assert!(waited.is_some_and(|w| w >= 0), "the replica did not reach {file}:{position}");
        }
        _ => unreachable!("a MySQL or PostgreSQL primary and replica"),
    }
}

/// Opens a connection to the primary and one to its replica side by side. A
/// model uses the connection it is connected to and no other, and a model
/// without a connection inside a transaction uses the transaction.
// Requirements: PLN-31, PLN-35.
async fn primary_and_replica_case(t: &Target, replica_base: &str) {
    let master = &t.db;
    // Waits, through the replica's existing database connection, until the replica receives the case database and the installed table.
    let replica_admin = model::connect(replica_base, 1, config()).await.unwrap();
    await_replica(master, &replica_admin).await;
    replica_admin.close().await;
    let slave1 = model::connect(&t.database.related_dsn(replica_base), 2, config()).await.unwrap();
    let name = format!("replica-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
    User::new().connect(master).set_name(&name).create().await.unwrap();
    await_replica(master, &slave1).await;
    assert_eq!(User::new().connect(&slave1).name(name.as_str()).get_count().await.unwrap(), 1, "the replica reads the row written through the primary");
    assert_eq!(
        code(User::new().connect(&slave1).set_name(format!("{name}-replica")).create().await),
        polyspec_orm::codes::READ_ONLY,
        "a write through the replica connection is rejected"
    );
    assert_eq!(
        User::new().connect(master).name(format!("{name}-replica").as_str()).get_count().await.unwrap(),
        0,
        "a write through the replica connection does not reach the primary"
    );
    // A row read through the replica is written through the primary.
    let mut row = User::new().connect(&slave1).name(name.as_str()).get().await.unwrap().expect("a row").connect(master).set_name(format!("{name}-renamed"));
    row.update(false).await.unwrap();
    let tx_name = format!("{name}-tx");
    let r: polyspec_orm::Result<()> = master
        .transaction(async || {
            User::new().set_name(tx_name.as_str()).create().await?;
            assert_eq!(User::new().connect(master).name(tx_name.as_str()).get_count().await?, 1, "the primary connection inside its transaction");
            assert_eq!(User::new().connect(&slave1).name(tx_name.as_str()).get_count().await?, 0, "the replica connection reads no uncommitted row");
            Ok(())
        })
        .await;
    r.unwrap();
    await_replica(master, &slave1).await;
    let committed = vec![format!("{name}-renamed"), tx_name.clone()];
    assert_eq!(User::new().connect(&slave1).name(committed).get_count().await.unwrap(), 2, "the replica reads the committed rows");
    slave1.close().await;
}

/// Writes through a connection to a SQLite database file the process may
/// only read: SQLite opens it read-only, reads succeed, and a write returns
/// READ_ONLY.
async fn read_only_sqlite(t: &Target) {
    use std::os::unix::fs::PermissionsExt;
    let path = t.database.path().expect("a SQLite case database file");
    User::new().connect(&t.db).set_name("read-only").create().await.unwrap();
    t.db.close().await;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o444)).unwrap();
    let db = model::connect(&t.dsn, 2, config()).await.unwrap();
    assert_eq!(User::new().connect(&db).name("read-only").get_count().await.unwrap(), 1, "the read-only database reads the row");
    assert_eq!(code(User::new().connect(&db).set_name("rejected").create().await), polyspec_orm::codes::READ_ONLY, "a write to the read-only database");
    db.close().await;
}

/// Checks schema().empty() on a new case database, with an empty PostgreSQL
/// schema other than public, and with the installed tables.
// Requirements: DBS-108, INT-58, SCH-7.
// Requirements: COD-8, PLN-44, INT-60, INT-75, INT-131.
/// A jsontext column reads back the ordered-json value of a write with its
/// member order, number text, and `{}` apart from `[]`; SQL NULL is distinct
/// from a JSON literal null.
async fn json_values_case(t: &Target) {
    fn expect_ordered(value: polyspec_orm::StyledValue<polyspec_orm::ordered_json::Value>, text: &str) {
        match value {
            polyspec_orm::StyledValue::Value(value) => assert_eq!(value.compact(), text),
            polyspec_orm::StyledValue::SqlNull => panic!("expected an encoded JSON value"),
        }
    }
    let db = &t.db;
    assert_eq!(Author::new().get_jsons_tags().unwrap_err().code(), polyspec_orm::codes::COLUMN_UNSELECTED, "unselected JSON column");
    let f = seed(db).await;
    let text = r#"{"b":1,"a":[],"c":{},"n":1.50}"#;
    let tags = r#"["z",{"y":[]},-0.0]"#;
    let seq = f.authors[0].get_seq().unwrap();
    let b = Author::new().connect(db).get_by_seq(seq).await.unwrap().expect("a row");
    let mut b = b
        .set_json_setting(polyspec_orm::StyledValue::Value(polyspec_orm::ordered_json::parse(text).unwrap()))
        .unwrap()
        .set_jsons_tags(polyspec_orm::StyledValue::Value(polyspec_orm::ordered_json::parse(tags).unwrap()))
        .unwrap();
    b.update(false).await.unwrap();
    let got = Author::new().connect(db).add_all_columns().get_by_seq(seq).await.unwrap().expect("a row");
    expect_ordered(got.get_json_setting().unwrap(), text);
    expect_ordered(got.get_jsons_tags().unwrap(), tags);
    assert_eq!(
        got.to_array().unwrap().plain().unwrap()["json_setting"],
        serde_json::json!({"kind":"value","value":{"a": [], "b": 1, "c": {}, "n": 1.5}}),
        "array form"
    );
    let out = got.to_json().unwrap();
    assert!(
        out.contains(&format!(r#""json_setting":{{"kind":"value","value":{text}}}"#))
            && out.contains(&format!(r#""jsons_tags":{{"kind":"value","value":{tags}}}"#)),
        "JSON output: {out}"
    );
    assert_eq!(serde_json::to_string(&got).unwrap(), out, "serde output");
    let rows = Author::new().connect(db).add_all_columns().seq(seq).gets().await.unwrap();
    assert_eq!(serde_json::to_string(&rows).unwrap(), format!("[{out}]"), "collection serde output");
    assert_eq!(rows.to_json().unwrap(), format!("[{out}]"), "collection JSON output");
    let created = Author::new()
        .connect(db)
        .set_name("json")
        .set_user_seq(f.users[0].get_seq().unwrap())
        .set_service_seq(f.service.get_seq().unwrap())
        .set_service_region_seq(f.authors[0].get_service_region_seq().unwrap())
        .set_service_member_seq(f.member.get_seq().unwrap())
        .set_start_dt(txt(start()))
        .unwrap()
        .set_end_dt(txt(start()))
        .unwrap();
    let created = match created.set_json_setting(polyspec_orm::StyledValue::Value(polyspec_orm::ordered_json::parse("[]").unwrap())) {
        Ok(row) => row,
        Err(error) => panic!("set json_setting: {error}"),
    };
    let mut created = match created.set_jsons_tags(polyspec_orm::StyledValue::Value(polyspec_orm::ordered_json::Value::null())) {
        Ok(row) => row,
        Err(error) => panic!("set jsons_tags: {error}"),
    };
    let created = created.create().await.unwrap();
    expect_ordered(created.get_json_setting().unwrap(), "[]");
    let got = Author::new().connect(db).add_all_columns().get_by_seq(created.get_seq().unwrap()).await.unwrap().expect("a row");
    expect_ordered(got.get_json_setting().unwrap(), "[]");
    expect_ordered(got.get_jsons_tags().unwrap(), "null");
    assert_eq!(got.to_array().unwrap().plain().unwrap()["jsons_tags"], serde_json::json!({"kind":"value","value":null}), "JSON literal null output");
    let mut got = got.set_jsons_tags(polyspec_orm::StyledValue::SqlNull).unwrap();
    got.update(false).await.unwrap();
    let sql_null = Author::new().connect(db).add_all_columns().get_by_seq(created.get_seq().unwrap()).await.unwrap().expect("a row");
    assert!(matches!(sql_null.get_jsons_tags().unwrap(), polyspec_orm::StyledValue::SqlNull), "SQL NULL remains explicit");
    assert_eq!(sql_null.to_array().unwrap().plain().unwrap()["jsons_tags"], serde_json::json!({"kind":"sql-null"}), "SQL NULL output");
    assert!(sql_null.to_json().unwrap().contains(r#""jsons_tags":{"kind":"sql-null"}"#), "SQL NULL model JSON output");
    let mut object = sql_null.set_jsons_tags(polyspec_orm::StyledValue::Value(polyspec_orm::ordered_json::parse(r#"{"kind":"sql-null"}"#).unwrap())).unwrap();
    object.update(false).await.unwrap();
    let object = Author::new().connect(db).add_all_columns().get_by_seq(created.get_seq().unwrap()).await.unwrap().expect("a row");
    assert_eq!(
        object.to_array().unwrap().plain().unwrap()["jsons_tags"],
        serde_json::json!({"kind":"value","value":{"kind":"sql-null"}}),
        "document members cannot collide with the column tag"
    );
}

/// The drivers that each section runs its case on, each in a case database of its own.
const DRIVERS: [&str; 3] = ["sqlite", "mysql", "postgres"];

/// Checks that the models were generated from the bench set (contracts/fixtures/bench/dbspec-set.json), which the sections
/// install; the set is read from the checkout of the crate.
fn check_bench_set() {
    let path = polyspec_orm_testcase::manifest_dir().join("../../../contracts/fixtures/bench/dbspec-set.json");
    let set = polyspec_orm::dbspec::read_set(&path).or_panic(|errors| format!("{}: {errors:?}", path.display()));
    let text = |file: &polyspec_orm::dbspec::SetFile| {
        polyspec_orm::dbspec::read_bytes(&file.path.display().to_string(), file.bytes.clone()).or_panic(|errors| format!("{}: {errors:?}", file.path.display()))
    };
    let owned: Vec<String> = set.documents.iter().map(text).collect();
    let external: Vec<String> = set.external.iter().map(text).collect();
    let parsed =
        polyspec_orm::dbspec::parse_set(&owned.iter().map(String::as_str).collect::<Vec<_>>(), &external.iter().map(String::as_str).collect::<Vec<_>>());
    let documents: Vec<polyspec_orm::dbspec::Document> =
        parsed.into_iter().map(|d| d.document.unwrap_or_else(|| panic!("{}: {:?}", path.display(), d.diagnostics))).collect();
    let manifest = polyspec_orm::dbspec::manifest(&documents.iter().collect::<Vec<_>>()).or_panic(|errors| format!("{}: {errors:?}", path.display()));
    assert_eq!(manifest.manifest_hash, model::MANIFEST_HASH, "the models were generated from another document set");
}

/// Runs the section case `body` on a case database of `driver` where the bench set is installed; each case installs its schema in
/// its own case database and runs no more than a few hundred statements.
async fn installed_section(driver: &str, body: impl AsyncFn(&Target)) {
    let t = Target::installed(driver).await;
    body(&t).await;
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn conditions() {
    check_bench_set();
    for driver in DRIVERS {
        let case = polyspec_orm_testcase::start(format!("conditions/{driver}"), polyspec_orm_testcase::DATABASE);
        installed_section(driver, conditions_case).await;
        drop(case);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn columns_and_subqueries() {
    check_bench_set();
    for driver in DRIVERS {
        let case = polyspec_orm_testcase::start(format!("columns_and_subqueries/{driver}"), polyspec_orm_testcase::DATABASE);
        installed_section(driver, columns_and_subqueries_case).await;
        drop(case);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn writes() {
    check_bench_set();
    for driver in DRIVERS {
        let case = polyspec_orm_testcase::start(format!("writes/{driver}"), polyspec_orm_testcase::DATABASE);
        installed_section(driver, writes_case).await;
        drop(case);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn json_values() {
    check_bench_set();
    for driver in DRIVERS {
        let case = polyspec_orm_testcase::start(format!("json_values/{driver}"), polyspec_orm_testcase::DATABASE);
        installed_section(driver, json_values_case).await;
        drop(case);
    }
}

/// SQLite reads a database file it may only read; MySQL and PostgreSQL read through a replica of the primary, whose DSN is
/// ORM_TEST_<DRIVER>_REPLICA_DSN.
#[tokio::test(flavor = "multi_thread")]
async fn primary_and_replica() {
    check_bench_set();
    for driver in DRIVERS {
        let case = polyspec_orm_testcase::start(format!("primary_and_replica/{driver}"), polyspec_orm_testcase::DATABASE);
        let t = Target::installed(driver).await;
        if driver == "sqlite" {
            read_only_sqlite(&t).await;
            case.step("read_only_sqlite");
        } else {
            let var = format!("ORM_TEST_{}_REPLICA_DSN", driver.to_uppercase());
            let replica = match std::env::var(&var) {
                Ok(v) if !v.is_empty() => v,
                Ok(_) => panic!(
                    "{var} is set but empty; database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers"
                ),
                Err(error) => panic!(
                    "{var} is required ({error}); database tests never skip; run the test through its make target, which reads the environment of make orm-test-servers"
                ),
            };
            primary_and_replica_case(&t, &replica).await;
        }
        t.finish().await;
        drop(case);
    }
}

/// The text form of a datetime column, which the date setters take (T189).
fn txt(t: chrono::NaiveDateTime) -> String {
    t.format("%Y-%m-%d %H:%M:%S%.f").to_string()
}
