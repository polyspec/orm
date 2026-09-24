//! Generated model integration test on SQLite, MySQL and PostgreSQL.
//! ORM_TEST_MYSQL_DSN and ORM_TEST_POSTGRES_DSN name empty test databases (the
//! test drops its tables there and installs the schema); the test fails when
//! either is unset.
//!
//! Usage: integration <schema.json>
use std::cell::Cell;
use std::path::PathBuf;

orm::models!();

use model::{Account, Battle, CompositeAccount, CompositeMembership, Service, ServiceMember, ServiceModule, User};
use orm::db::Pool;
use orm::{AesKeyring, Collection, Db, Isolation, Null};

const TABLES: &[&str] = &[
    "account_project",
    "composite_membership",
    "composite_account",
    "battle",
    "service_member",
    "service_module",
    "soft_record",
    "account",
    "project",
    "user",
    "service",
    "task",
];

struct Env {
    schema: Vec<u8>,
    tmp: PathBuf,
}

struct Target {
    driver: &'static str,
    dsn: String,
    db: Db,
}

fn config() -> orm::Config {
    orm::Config { aes_key: "test-aes-key".into(), blind_index_key: "test-blind-key".into(), ..Default::default() }
}

fn code<T>(r: orm::Result<T>) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => e.code().to_owned(),
    }
}

impl Env {
    /// Fresh databases for each dialect with the schema installed.
    async fn databases(&self, test: &str) -> Vec<Target> {
        let targets = self.without_tables(test).await;
        for t in &targets {
            t.db.utils().schema().install(&self.schema).await.unwrap_or_else(|e| panic!("{}: schema().install: {e}", t.driver));
            t.db.utils().schema().install(&self.schema).await.unwrap_or_else(|e| panic!("{}: schema().install again: {e}", t.driver));
        }
        targets
    }

    /// Databases for each dialect without the test tables: a new SQLite file
    /// and the MySQL and PostgreSQL test databases with the tables dropped.
    async fn without_tables(&self, test: &str) -> Vec<Target> {
        let sqlite = self.tmp.join(format!("{test}.sqlite"));
        let _ = std::fs::remove_file(&sqlite);
        let mut targets = vec![("sqlite", format!("sqlite://{}?_pragma=busy_timeout(5000)", sqlite.display()))];
        for (driver, var) in [("mysql", "ORM_TEST_MYSQL_DSN"), ("postgres", "ORM_TEST_POSTGRES_DSN")] {
            match std::env::var(var) {
                Ok(dsn) if !dsn.is_empty() => targets.push((driver, dsn)),
                _ => panic!("{var} is required; database tests never skip"),
            }
        }
        let mut out = Vec::new();
        for (driver, dsn) in targets {
            let db = Db::connect(&dsn, 4, config()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
            let statement = |sql: String| sqlx::raw_sql(sqlx::AssertSqlSafe(sql));
            match db.pool() {
                Pool::MySql(p) => {
                    let mut conn = p.acquire().await.unwrap();
                    let mut drop = String::from("SET FOREIGN_KEY_CHECKS = 0;");
                    for t in TABLES {
                        drop.push_str(&format!("DROP TABLE IF EXISTS `{t}`;"));
                    }
                    drop.push_str("SET FOREIGN_KEY_CHECKS = 1;");
                    statement(drop).execute(&mut *conn).await.unwrap();
                }
                Pool::Postgres(p) => {
                    let drop: String = TABLES.iter().map(|t| format!("DROP TABLE IF EXISTS \"{t}\" CASCADE;")).collect();
                    statement(drop).execute(p).await.unwrap();
                }
                Pool::Sqlite(_) => {}
            }
            out.push(Target { driver, dsn, db });
        }
        out
    }
}

struct Fixture {
    service: Service,
    member: ServiceMember,
    users: Vec<User>,
    battles: Vec<Battle>,
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
    let module = ServiceModule::new().connect(db).set_service_seq(service.get_seq()).set_name("module").create().await.unwrap();
    let member = ServiceMember::new().connect(db).set_service_seq(service.get_seq()).set_user_seq(users[0].get_seq()).create().await.unwrap();
    let mut battles = Vec::new();
    for (i, name) in ["alpha", "beta", "gamma", "delta"].into_iter().enumerate() {
        let i = i as i64;
        let mut b = Battle::new()
            .connect(db)
            .set_name(name)
            .set_user_seq(users[(i % 2) as usize].get_seq())
            .set_service_seq(service.get_seq())
            .set_service_module_seq(module.get_seq())
            .set_service_member_seq(member.get_seq())
            .set_start_dt(start() + chrono::Duration::hours(i))
            .set_end_dt(start() + chrono::Duration::hours(48))
            .set_read_count(i * 10)
            .set_is_close(i % 2 == 1);
        if i < 2 {
            b = b.set_cover_url(format!("cover-{name}"));
        }
        battles.push(b.create().await.unwrap());
    }
    Fixture { service, member, users, battles }
}

fn names(c: &Collection<Battle>) -> String {
    c.models().map(|b| b.get_name().to_owned()).collect::<Vec<_>>().join(",")
}

async fn conditions(t: &Target) {
    let db = &t.db;
    let f = seed(db).await;
    let svc = f.service.get_seq();
    let rows = Battle::new().connect(db).service_seq(svc).and_is_close(false).or(()).is_close(true).order_by_seq_asc().gets().await.unwrap();
    assert_eq!(names(&rows), "alpha,beta,gamma,delta", "connectors");
    let rows = Battle::new()
        .connect(db)
        .service_seq(svc)
        .and(|q: Battle| q.ge_read_count(10).and_lt_read_count(30).or(()).name("alpha"))
        .order_by_read_count_desc_and_seq_asc()
        .gets()
        .await
        .unwrap();
    assert_eq!(names(&rows), "gamma,beta,alpha", "group");
    let rows = Battle::new().connect(db).gets_by_seq_and_ne_name(vec![f.battles[0].get_seq(), f.battles[1].get_seq()], "beta").await.unwrap();
    assert_eq!(names(&rows), "alpha", "gets_by list");
    assert_eq!(Battle::new().connect(db).cover_url(Null).get_count().await.unwrap(), 2, "null");
    assert_eq!(Battle::new().connect(db).ne_cover_url(Null).and_lk_name("lph").get_count().await.unwrap(), 1, "not null and like");
    assert_eq!(Battle::new().connect(db).between_read_count([10, 20]).get_count().await.unwrap(), 2, "between");
    assert_eq!(Battle::new().connect(db).gt_start_dt(start() + chrono::Duration::minutes(90)).get_count().await.unwrap(), 2, "time compare");
    let one = Battle::new().connect(db).get_by_name("gamma").await.unwrap();
    assert_eq!(one.get_read_count(), 20, "get_by");
    assert_eq!(code(Battle::new().connect(db).get_by_name("missing").await), "NO_ROWS", "get without a row");
    let q = Battle::new().connect(db).service_seq(svc);
    let first = q.get_count_by_is_close(true).await.unwrap();
    let second = q.get_count().await.unwrap();
    assert_eq!((first, second), (2, 4), "a terminal changed the model");
    assert_eq!(Battle::new().connect(db).raw("{read_count} >= ?", [20]).get_count().await.unwrap(), 2, "raw");
    assert_eq!(code(Battle::new().connect(db).name("a").is_close(true).gets().await), "CONFIG", "missing connector");
    assert_eq!(code(Battle::new().connect(db).name("a").and(()).gets().await), "CONFIG", "dangling connector");
    assert_eq!(code(Battle::new().connect(db).seq(Vec::<i64>::new()).gets().await), "EMPTY_IN", "empty list");
    let stmt = Battle::new().connect(db).name("alpha").get_query().await.unwrap();
    assert!(stmt.sql.contains("name") && stmt.binds.len() == 1, "get_query: {} {:?}", stmt.sql, stmt.binds);
    assert_eq!(code(Battle::new().name("alpha").gets().await), "CONFIG", "no connection");
}

async fn joins_and_relations(t: &Target) {
    let db = &t.db;
    let f = seed(db).await;
    let author = User::new().on(|u: User| u.ne_name("nobody")).name("kim");
    let rows = Battle::new()
        .connect(db)
        .left_join_user_seq_with_seq(author.clone())
        .service_seq(f.service.get_seq())
        .and(|q: Battle| q.name("delta").or(&author))
        .order_by_seq_asc()
        .gets()
        .await
        .unwrap();
    assert_eq!(names(&rows), "alpha,gamma,delta", "placed join conditions");
    assert_eq!(rows.first().and_then(|b| b.get_user_model()).map(|u| u.get_name().to_owned()).as_deref(), Some("kim"), "join result");
    let member = ServiceMember::new();
    let cmp = Battle::new().connect(db).join_service_member_seq_with_seq(member.clone()).read_count_gt_seq(&member).get_count().await.unwrap();
    assert_eq!(cmp, 3, "column comparison with a joined model");

    let writer = User::new().match_user_seq_with_seq().alias_writer();
    let loaded = Battle::new()
        .connect(db)
        .relation(writer)
        .relations(ServiceMember::new().match_service_seq_with_service_seq().alias_members())
        .relation(ServiceModule::new().match_service_module_seq_with_seq())
        .order_by_seq_asc()
        .gets()
        .await
        .unwrap();
    let b = loaded.first().unwrap();
    assert_eq!(b.get_writer().map(|u| u.get_name()), Some("kim"), "relation alias");
    assert_eq!(b.get_members().map(|c| c.len()), Some(1), "relations");
    assert_eq!(b.get_service_module_model().map(|m| m.get_name()), Some("module"), "relation");
    let limited =
        User::new().connect(db).relations(Battle::new().match_seq_with_user_seq().order_by_seq_desc().group_limit(1)).order_by_seq_asc().gets().await.unwrap();
    let got = limited.first().and_then(|u| u.get_battle_models()).expect("battle models");
    assert_eq!(names(got), "gamma", "group_limit");

    let other = Db::connect(&t.dsn, 2, orm::Config::default()).await.unwrap();
    let external = Battle::new().connect(db).relation(User::new().connect(&other).match_user_seq_with_seq().alias_owner()).get_by_name("beta").await.unwrap();
    assert_eq!(external.get_owner().map(|u| u.get_name()), Some("lee"), "relation on another connection");
    other.close().await;
    assert_eq!(code(Battle::new().connect(db).join_user_seq_with_seq(User::new().connect(db)).gets().await), "CONFIG", "join child with connection");
    assert_eq!(code(Battle::new().connect(db).name("a").or(&User::new()).gets().await), "CONFIG", "unjoined model placement");
    let array = b.to_array().unwrap();
    assert!(!array["writer"].is_null() && array["name"] == "alpha", "to_array: {array}");
    let _ = (&f.member, &f.users);
}

async fn columns_and_subqueries(t: &Target) {
    let db = &t.db;
    let f = seed(db).await;
    let users = User::new()
        .connect(db)
        .add_column_read_total(|u: &User| Battle::new().sum_read_count().user_seq_eq_seq(u))
        .add_raw_column_doubled("({seq} * ?)", [2])
        .add_column_name_alias_upper_name("UPPER(%s)")
        .seq(Battle::new().add_column_user_seq().is_close(false))
        .order_by_seq_asc()
        .gets()
        .await
        .unwrap();
    assert_eq!(users.len(), 1, "subquery IN");
    let u = users.first().unwrap();
    let int =
        |v: Option<serde_json::Value>| v.and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)).or_else(|| v.as_str().and_then(|s| s.parse().ok())));
    assert_eq!(int(u.get_read_total().unwrap()), Some(20), "subquery column");
    assert_eq!(int(u.get_doubled().unwrap()), Some(2 * u.get_seq()), "raw column");
    assert_eq!(u.get_upper_name().unwrap(), Some(serde_json::json!("KIM")), "format column");
    let sum = Battle::new().connect(db).service_seq(f.service.get_seq()).sum_read_count().get_sum().await.unwrap();
    let avg = Battle::new().connect(db).service_seq(f.service.get_seq()).avg_read_count().get_avg().await.unwrap();
    assert_eq!((sum, avg), (60.0, 15.0), "aggregates");
    let grouped = Battle::new().connect(db).group_by_is_close().gets_count().await.unwrap();
    assert_eq!(grouped.len(), 2, "gets_count");
    let page = Battle::new().connect(db).order_by_seq_asc().gets_page(2, 3).await.unwrap();
    assert_eq!((page.total_count, page.total_pages, page.items.len()), (4, 2, 1), "page");
    assert_eq!(page.items.first().map(|b| b.get_name()), Some("delta"), "page item");
    let keyed = Battle::new().connect(db).key_name_name().gets().await.unwrap();
    assert!(keyed.get("beta").is_some(), "key_name");
    let fetched = Battle::new()
        .connect(db)
        .fetch_key(|b: &Battle| b.get_read_count())
        .fetch_value(|b: &Battle| serde_json::json!(b.get_name().len()))
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
    assert_eq!(CompositeMembership::new().connect(db).creates(memberships).await.unwrap(), 3, "creates");
    let pairs = CompositeMembership::new().connect(db).tuple_tenant_id_with_account_id(vec![(1, 10), (2, 10)]).get_count().await.unwrap();
    assert_eq!(pairs, 2, "tuple");
}

async fn writes(t: &Target) {
    let db = &t.db;
    let f = seed(db).await;
    let b = Battle::new().connect(db).get_by_seq(f.battles[0].get_seq()).await.unwrap();
    let mut b = b.set_name("renamed").plus_read_count(5);
    b.update(true).await.unwrap();
    let again = Battle::new().connect(db).get_by_seq(b.get_seq()).await.unwrap();
    assert_eq!((again.get_name(), again.get_read_count()), ("renamed", 5), "update");
    let mut b = b.set_name("stale");
    assert_eq!(code(b.update(true).await), "CONFIG", "optimistic update without a fresh version");
    let mut again = again.set_name("again");
    again.update(false).await.unwrap();
    let mut b = b.set_name("x");
    b.update(false).await.unwrap();
    let item = Account::new().connect(db).set_name("acc").new_label("shown").create().await.unwrap();
    assert_eq!(item.get_label().unwrap(), Some(serde_json::json!("shown")), "new value");
    assert_eq!(item.to_array().unwrap()["label"], "shown", "new value output");
    let saved = Account::new().connect(db).set_seq(item.get_seq()).set_name("saved").save().await.unwrap();
    assert_eq!(saved.get_name(), "saved", "save result");
    let stored = Account::new().connect(db).get_by_seq(item.get_seq()).await.unwrap();
    assert_eq!(stored.get_name(), "saved", "save as update");
    Battle::new().connect(db).get_by_seq(f.battles[3].get_seq()).await.unwrap().delete(false).await.unwrap();
    assert_eq!(Battle::new().connect(db).get_count().await.unwrap(), 3, "delete");
    let rows = Battle::new().connect(db).is_close(true).gets().await.unwrap();
    rows.delete(false).await.unwrap();
    assert_eq!(Battle::new().connect(db).get_count().await.unwrap(), 2, "collection delete");
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
    let got = CompositeAccount::new().connect(db).get_by_tenant_id_and_account_id(9, 9).await.unwrap();
    assert_eq!(got.get_name(), "second", "duplication");
    let service = Service::new().connect(db).set_name("tree").create().await.unwrap();
    ServiceMember::new().connect(db).set_service_seq(service.get_seq()).set_user_seq(f.users[1].get_seq()).create().await.unwrap();
    let tree = Service::new().connect(db).relations(ServiceMember::new().match_seq_with_service_seq()).get_by_seq(service.get_seq()).await.unwrap();
    tree.delete(true).await.unwrap();
    assert_eq!(ServiceMember::new().connect(db).get_count_by_service_seq(service.get_seq()).await.unwrap(), 0, "recursive delete");
    let copy = Service::new().connect(db).get_by_seq(f.service.get_seq()).await.unwrap();
    let json = serde_json::to_value(&copy).unwrap();
    assert_eq!(json["name"], "service", "serialize");
}

async fn transactions(t: &Target) {
    let db = &t.db;
    let boom = || orm::Error::Config("boom".into());
    let is_boom = |r: &orm::Result<()>| matches!(r, Err(orm::Error::Config(m)) if m == "boom");
    let r: orm::Result<()> = db
        .transaction(async || {
            User::new().set_name("rolled back").create().await?;
            Err(boom())
        })
        .await;
    assert!(is_boom(&r), "rollback error: {r:?}");
    assert_eq!(User::new().connect(db).get_count().await.unwrap(), 0, "rollback");
    let r: orm::Result<()> = db
        .transaction(async || {
            User::new().set_name("outer").create().await?;
            let inner: orm::Result<()> = db
                .transaction(async || {
                    User::new().set_name("inner").create().await?;
                    Err(boom())
                })
                .await;
            assert!(is_boom(&inner), "inner: {inner:?}");
            assert_eq!(User::new().get_count().await?, 1, "savepoint rollback");
            User::new().name("outer").for_update().gets().await?;
            db.utils().lock("users").await?;
            db.utils().set_local("app.actor", "tester").await?;
            assert_eq!(db.utils().local("app.actor")?, "tester", "local");
            assert_eq!(code(db.utils().local("app.missing")), "NO_ROWS", "missing local");
            let spawned = tokio::spawn(async { User::new().get_count().await.map_err(|e| e.code().to_owned()) }).await.unwrap();
            assert_eq!(spawned.err().as_deref(), Some("CONFIG"), "a spawned task inherited the transaction");
            Ok(())
        })
        .isolation(Isolation::ReadCommitted)
        .retry(0)
        .await;
    r.unwrap();
    assert_eq!(User::new().connect(db).get_count().await.unwrap(), 1, "commit");
    assert_eq!(code(User::new().connect(db).for_update().gets().await), "CONFIG", "lock outside a transaction");
    assert_eq!(code(db.utils().lock("x").await), "CONFIG", "lock utility outside a transaction");
    let attempts = Cell::new(0);
    let r: orm::Result<()> = db
        .transaction(async || {
            attempts.set(attempts.get() + 1);
            if attempts.get() < 3 {
                return Err(orm::transaction_conflict("retry"));
            }
            Ok(())
        })
        .await;
    assert!(r.is_ok() && attempts.get() == 3, "retry: {} {r:?}", attempts.get());
    let r: orm::Result<()> = db.transaction(async || Ok(())).read_only().timeout_ms(500).await;
    match t.driver {
        "postgres" => r.unwrap(),
        _ => assert_eq!(code(r), "CAPABILITY_UNSUPPORTED", "timeout_ms"),
    }
    assert!(!db.utils().schema().empty().await.unwrap(), "schema().empty() on an installed schema");
    db.utils().schema().installed("public", "user").await.unwrap();
    assert_eq!(code(db.utils().privileges().inspect_table("public.user").await).as_str() == "CAPABILITY_UNSUPPORTED", t.driver != "postgres", "privileges");
    assert!(db.utils().stats().open_connections >= 1, "stats");
}

/// Checks schema().empty() on a database without the test tables, with an
/// empty PostgreSQL schema other than public, and with the installed tables.
async fn schema_empty(t: &Target, schema: &[u8]) {
    let db = &t.db;
    assert!(db.utils().schema().empty().await.unwrap(), "{}: schema().empty() on a database without tables", t.driver);
    if let Pool::Postgres(p) = db.pool() {
        sqlx::raw_sql("CREATE SCHEMA unowned_empty").execute(p).await.unwrap();
        let with_schema = db.utils().schema().empty().await;
        sqlx::raw_sql("DROP SCHEMA unowned_empty").execute(p).await.unwrap();
        assert!(!with_schema.unwrap(), "postgres: schema().empty() with an empty schema other than public");
        assert!(db.utils().schema().empty().await.unwrap(), "postgres: schema().empty() after the empty schema is dropped");
    }
    db.utils().schema().install(schema).await.unwrap();
    assert!(!db.utils().schema().empty().await.unwrap(), "{}: schema().empty() with the installed tables", t.driver);
}

/// Inserts and reads more values than SQLite binds in one statement: the
/// inserts and the root IN list are split, duplicate IN values are read once,
/// and a shape that a merge would change is rejected.
async fn bind_limit_splitting(t: &Target) {
    let db = &t.db;
    const N: usize = 1200;
    let mut rows = Vec::with_capacity(N);
    let mut names: Vec<String> = Vec::with_capacity(N + 300);
    for i in 0..N {
        let name = format!("chunk-{i:04}");
        rows.push(Service::new().set_name(name.clone()));
        names.push(name);
    }
    assert_eq!(Service::new().connect(db).creates(rows).await.unwrap(), N as u64, "inserted");
    names.extend(names[..200].to_vec());
    names.extend((0..100).map(|i| format!("missing-{i}")));
    let found = Service::new().connect(db).name(names.clone()).gets().await.unwrap();
    assert_eq!(found.len(), N, "found");
    assert_eq!(Service::new().connect(db).name(names.clone()).get_count().await.unwrap(), N as i64, "count");
    if t.driver == "sqlite" {
        let limited = Service::new().connect(db).name(names).limit(0, 10).gets().await;
        assert_eq!(code(limited), orm::codes::IR_INVALID, "limited split");
    }
}

async fn aes_rotation(t: &Target) {
    let db = &t.db;
    let f = seed(db).await;
    let b = Battle::new().connect(db).get_by_seq(f.battles[0].get_seq()).await.unwrap();
    let mut b = b.set_aes_hex_email("person@example.com");
    b.update(false).await.unwrap();
    let found = Battle::new().connect(db).aes_hex_email("person@example.com").get_count().await.unwrap();
    assert_eq!(found, 1, "blind index condition");
    let keyring = AesKeyring::new([(1, "test-aes-key".to_owned()), (2, "next-aes-key".to_owned())].into_iter().collect(), 2).unwrap();
    let status = db.utils().aes().status(&Battle::new(), &keyring).await.unwrap();
    assert_eq!((status.total, status.pending), (4, 4), "status");
    assert_eq!(db.utils().aes().rotate(&Battle::new(), &keyring).await.unwrap(), 4, "rotated");
    let status = db.utils().aes().status(&Battle::new(), &keyring).await.unwrap();
    assert_eq!(status.pending, 0, "after rotation");
}

/// A jsontext column reads back the ordered-json value of a write with its
/// member order, number text, and `{}` apart from `[]`; the JSON null stores NULL.
async fn json_values(t: &Target) {
    let db = &t.db;
    let f = seed(db).await;
    let text = r#"{"b":1,"a":[],"c":{},"n":1.50}"#;
    let tags = r#"["z",{"y":[]},-0.0]"#;
    let seq = f.battles[0].get_seq();
    let b = Battle::new().connect(db).get_by_seq(seq).await.unwrap();
    let mut b = b.set_json_setting(orm::ordered_json::parse(text).unwrap()).set_jsons_tags(orm::ordered_json::parse(tags).unwrap());
    b.update(false).await.unwrap();
    let got = Battle::new().connect(db).add_all_columns().get_by_seq(seq).await.unwrap();
    assert_eq!(got.get_json_setting().compact(), text, "jsontext json read");
    assert_eq!(got.get_jsons_tags().compact(), tags, "jsontext jsons read");
    assert_eq!(got.to_array().unwrap()["json_setting"], serde_json::json!({"a": [], "b": 1, "c": {}, "n": 1.5}), "array form");
    let out = got.to_json().unwrap();
    assert!(out.contains(&format!(r#""json_setting":{text}"#)) && out.contains(&format!(r#""jsons_tags":{tags}"#)), "JSON output: {out}");
    assert_eq!(serde_json::to_string(&got).unwrap(), out, "serde output");
    let rows = Battle::new().connect(db).add_all_columns().seq(seq).gets().await.unwrap();
    assert_eq!(serde_json::to_string(&rows).unwrap(), format!("[{out}]"), "collection serde output");
    assert_eq!(rows.to_json().unwrap(), format!("[{out}]"), "collection JSON output");
    let created = Battle::new()
        .connect(db)
        .set_name("json")
        .set_user_seq(f.users[0].get_seq())
        .set_service_seq(f.service.get_seq())
        .set_service_module_seq(f.battles[0].get_service_module_seq())
        .set_service_member_seq(f.member.get_seq())
        .set_start_dt(start())
        .set_end_dt(start())
        .set_json_setting(orm::ordered_json::parse("[]").unwrap())
        .set_jsons_tags(orm::ordered_json::Value::null())
        .create()
        .await
        .unwrap();
    assert_eq!(created.get_json_setting().compact(), "[]", "created value");
    let got = Battle::new().connect(db).add_all_columns().get_by_seq(created.get_seq()).await.unwrap();
    assert_eq!(got.get_json_setting().compact(), "[]", "empty array read");
    assert_eq!(got.get_jsons_tags().kind(), orm::ordered_json::Kind::Null, "NULL reads as the JSON null");
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: integration <schema.json>");
        std::process::exit(2);
    }
    let tmp = std::env::temp_dir().join(format!("orm-rust-integration-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let schema = std::fs::read(&args[1]).expect("schema.json");
    assert_eq!(orm::Manifest::load(&schema).expect("schema manifest").schema_hash, model::SCHEMA_HASH, "the models were generated from another schema");
    let env = Env { schema, tmp: tmp.clone() };
    for t in env.without_tables("schema_empty").await {
        schema_empty(&t, &env.schema).await;
        t.db.close().await;
        println!("ok schema_empty ({})", t.driver);
    }
    for name in ["conditions", "joins_and_relations", "columns_and_subqueries", "writes", "transactions", "aes_rotation", "json_values", "bind_limit_splitting"]
    {
        for t in env.databases(name).await {
            match name {
                "conditions" => conditions(&t).await,
                "joins_and_relations" => joins_and_relations(&t).await,
                "columns_and_subqueries" => columns_and_subqueries(&t).await,
                "writes" => writes(&t).await,
                "transactions" => transactions(&t).await,
                "aes_rotation" => aes_rotation(&t).await,
                "json_values" => json_values(&t).await,
                _ => bind_limit_splitting(&t).await,
            }
            t.db.close().await;
            println!("ok {name} ({})", t.driver);
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
}
