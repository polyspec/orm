//! The model that reads and writes the item, item_history, and audit tables of contracts/fixtures/audit.dbs by column name, and
//! the helpers that work with those tables, and the audit record transaction case. audit.rs and coverage_audit_triggers.rs
//! both use them.

use std::collections::BTreeMap;

use polyspec_orm::db::Pool;
use polyspec_orm::{Core, Db, Entity, Model, Param, Schema, Val};
use sqlx::Row;

pub static SCHEMA: Schema =
    Schema::new(include_str!("../../../../../contracts/fixtures/audit.dbs"), "sha256:c651e923992a61fa5712620c7cf6cf7d1a509796b23c4ae597f58e9f561a0c1f");

/// A model that reads and writes values by column name.
macro_rules! row_model {
    ($name:ident, $entity:ident, $entity_name:literal, $columns:expr) => {
        static $entity: Entity =
            Entity { name: $entity_name, schema: &SCHEMA, new: polyspec_orm::model::new_boxed::<$name>, collect: polyspec_orm::model::collect_boxed::<$name> };

        #[derive(Clone)]
        pub struct $name {
            core: Core,
            values: BTreeMap<String, Val>,
        }

        impl Model for $name {
            fn entity() -> &'static Entity {
                &$entity
            }
            fn core(&self) -> &Core {
                &self.core
            }
            fn core_mut(&mut self) -> &mut Core {
                &mut self.core
            }
            fn from_core(core: Core) -> Self {
                $name { core, values: BTreeMap::new() }
            }
            fn into_core(self) -> Core {
                self.core
            }
            fn assign(&mut self, name: &str, v: Val) -> polyspec_orm::Result<bool> {
                if !$columns.contains(&name) {
                    return Ok(false);
                }
                self.values.insert(name.to_owned(), v);
                Ok(true)
            }
            fn value(&self, name: &str) -> Option<Val> {
                self.values.get(name).cloned()
            }
        }
    };
}

row_model!(Item, ITEM, "item", ["seq", "title", "audit_seq", "deleted_at"]);
row_model!(History, HISTORY, "item_history", ["history_id", "change", "previous_audit_seq", "seq", "title", "audit_seq", "deleted_at"]);

/// The `.audit(...)` argument of a transaction with no audit values.
#[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
pub const NO_VALUES: [(&str, &str); 0] = [];

pub fn model<M: Model>() -> M {
    M::from_core(Core::new(M::entity()))
}

pub fn connected<M: Model>(db: &Db) -> M {
    let mut core = Core::new(M::entity());
    core.connect(db);
    M::from_core(core)
}

/// An audit source that provides the actor as an audit value.
pub fn audit_source(actor: &str) -> polyspec_orm::AuditSource {
    let actor = actor.to_owned();
    std::sync::Arc::new(move || Ok(vec![("actor".to_owned(), Param::from(actor.as_str()))]))
}

/// A connection setting that provides the actor as an audit value.
pub fn audit_config(actor: &str) -> polyspec_orm::Config {
    polyspec_orm::Config { audit_source: Some(audit_source(actor)), ..Default::default() }
}

/// Connects to dsn with the config and registers audit.dbs. Installs the tables if they are missing.
pub async fn audit_db(dsn: &str, config: polyspec_orm::Config) -> Db {
    let db = Db::connect(dsn, 2, config).await.unwrap_or_else(|e| panic!("connect: {e}"));
    db.utils().schema().install(&SCHEMA).await.unwrap_or_else(|e| panic!("install: {e}"));
    db
}

/// Runs a statement and returns its result.
pub async fn try_exec(db: &Db, statement: &str) -> Result<(), sqlx::Error> {
    let sql = sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned()));
    match db.pool() {
        Pool::MySql(p) => sql.execute(p).await.map(|_| ()),
        Pool::Postgres(p) => sql.execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => sql.execute(p).await.map(|_| ()),
        Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
    }
}

// Only coverage_audit_triggers.rs uses this. audit.rs drops its whole case database.
#[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
pub async fn exec(db: &Db, statement: &str) {
    try_exec(db, statement).await.unwrap_or_else(|e| panic!("{statement}: {e}"));
}

/// Drops the fixture's tables and, on PostgreSQL, the trigger functions that are not dropped with the tables.
/// Only coverage_audit_triggers.rs uses this.
#[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
pub async fn drop_tables(db: &Db, driver: &str) {
    let q = |name: &str| if driver == "mysql" { format!("`{name}`") } else { format!("\"{name}\"") };
    for table in ["item_history", "item", "audit"] {
        exec(db, &format!("DROP TABLE IF EXISTS {}", q(table))).await;
    }
    if driver == "postgres" {
        for event in ["audit_insert", "audit_update", "audit_delete"] {
            exec(db, &format!("DROP FUNCTION IF EXISTS {}()", q(&format!("item${event}")))).await;
        }
    }
}

pub fn new_item(title: &str) -> Item {
    let mut row: Item = model();
    row.core_mut().set("title", Param::from(title));
    row
}

pub fn changed_item(seq: i64, title: &str) -> Item {
    let mut row: Item = model();
    row.core_mut().set("seq", Param::I64(seq));
    row.core_mut().set("title", Param::from(title));
    row
}

pub async fn history(db: &Db) -> Vec<BTreeMap<String, Val>> {
    let mut q: History = connected(db);
    q.core_mut().add_all_columns();
    q.core_mut().order_by("history_id", false, None);
    polyspec_orm::model::gets(&q).await.unwrap().into_vec().into_iter().map(|r| r.values).collect()
}

/// Reads (change, previous, seq, title, audit, deleted) of item_history in history_id order.
#[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
pub async fn history_summary(db: &Db) -> Vec<(String, Option<i64>, i64, String, i64, bool)> {
    history(db)
        .await
        .iter()
        .map(|r| {
            let previous = if r["previous_audit_seq"].is_null() { None } else { Some(r["previous_audit_seq"].as_i64().unwrap()) };
            let text = |column: &str| r[column].as_string().unwrap();
            (text("change"), previous, r["seq"].as_i64().unwrap(), text("title"), r["audit_seq"].as_i64().unwrap(), !r["deleted_at"].is_null())
        })
        .collect()
}

/// Reads the audit records as (seq, actor) strings in seq order.
#[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
pub async fn audit_records(db: &Db) -> Vec<(String, String)> {
    let query = "SELECT seq, actor FROM audit ORDER BY seq";
    macro_rules! read {
        ($pool:expr) => {{
            let rows = sqlx::raw_sql(sqlx::AssertSqlSafe(query.to_owned())).fetch_all($pool).await.unwrap_or_else(|e| panic!("{query}: {e}"));
            rows.iter().map(|r| (r.try_get::<i64, _>(0).unwrap().to_string(), r.try_get::<String, _>(1).unwrap())).collect()
        }};
    }
    match db.pool() {
        Pool::MySql(p) => read!(p),
        Pool::Postgres(p) => read!(p),
        Pool::Sqlite(p) => read!(p),
        Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
    }
}

pub fn code<T>(r: polyspec_orm::Result<T>) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => e.code().to_owned(),
    }
}

/// Checks the writes of a transaction that received an audit record (in the same order as auditCase in
/// packages/go/orm/audit_transaction_test.go). The db has audit.dbs installed and its tables are empty. It checks:
///   - the transaction inserts, before the callback, one record combining the values from the connection setting's audit source and the transaction's audit values,
///     into the references table of the audit setting (for the same column, the transaction value wins), and
///     inserts, updates, and soft deletes write the
///     primary key to the audit column. The trigger keeps each version in the history table, and previous is the
///     audit key of the previous version.
///   - an audit transaction on a connection with no audit source, or a value that is not a column of the audit record table (a transaction or
///     source value) is CONFIG, and a source's error is the transaction's error.
///   - a nested transaction uses the outer audit and does not receive its own audit (CONFIG).
///   - an audit table write without audit is CONFIG. A raw write that points to a missing audit record is
///     rejected by its foreign key.
///   - if the callback fails, the audit record is also rolled back.
#[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
pub async fn audit_case(driver: &str, dsn: &str) {
    let adb = audit_db(dsn, audit_config("default")).await;
    let db = &adb;
    let mut outside = new_item("outside");
    outside.core_mut().connect(db);
    assert_eq!(code(polyspec_orm::model::create(&mut outside).await), polyspec_orm::codes::CONFIG, "{driver}: insert without an audit");
    let no_column: polyspec_orm::AuditSource = std::sync::Arc::new(|| Ok(vec![("reason".to_owned(), Param::from("x"))]));
    for (name, config) in [
        ("without an audit source", polyspec_orm::Config::default()),
        ("with a source value that is no column", polyspec_orm::Config { audit_source: Some(no_column), ..Default::default() }),
    ] {
        let other = audit_db(dsn, config).await;
        let failed = other.transaction(async || Ok(())).audit([("actor", "x")]).await;
        other.close().await;
        assert_eq!(code(failed), polyspec_orm::codes::CONFIG, "{driver}: an audit transaction of a connection {name}");
    }
    let unavailable: polyspec_orm::AuditSource =
        std::sync::Arc::new(|| Err(polyspec_orm::Error::Engine { code: "UNAVAILABLE".into(), msg: "no request".into() }));
    let failing = audit_db(dsn, polyspec_orm::Config { audit_source: Some(unavailable), ..Default::default() }).await;
    let failed = failing.transaction(async || Ok(())).audit(NO_VALUES).await;
    failing.close().await;
    assert!(
        matches!(&failed, Err(polyspec_orm::Error::Engine { code, msg }) if code == "UNAVAILABLE" && msg == "no request"),
        "{driver}: an audit transaction whose source fails: {failed:?}"
    );
    let unknown = adb.transaction(async || Ok(())).audit([("reason", "x")]).await;
    assert_eq!(code(unknown), polyspec_orm::codes::CONFIG, "{driver}: an audit value that is no column");
    let seq = adb
        .transaction(async || {
            let seq = polyspec_orm::model::create(&mut new_item("first")).await?.value("seq").expect("generated seq").as_i64()?;
            let nested = adb.transaction(async || Ok(())).audit([("actor", "nested")]).await;
            assert_eq!(code(nested), polyspec_orm::codes::CONFIG, "{driver}: a nested transaction with an audit");
            // The nested transaction uses the outer audit.
            db.transaction(async || polyspec_orm::model::update(&mut changed_item(seq, "second"), false).await).retry(0).await?;
            Ok(seq)
        })
        .audit([("actor", "create")])
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: create: {e}"));
    let mut titled = changed_item(seq, "third");
    titled.core_mut().connect(db);
    assert_eq!(code(polyspec_orm::model::update(&mut titled, false).await), polyspec_orm::codes::CONFIG, "{driver}: update without an audit");
    // An audit transaction with no values records only defaults.
    adb.transaction(async || polyspec_orm::model::delete(&changed_item(seq, "second"), false).await)
        .audit(NO_VALUES)
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: delete: {e}"));
    let failed = adb.transaction(async || Err::<(), _>(polyspec_orm::Error::Config("callback failed".into()))).audit([("actor", "rolled back")]).retry(0).await;
    assert!(matches!(&failed, Err(polyspec_orm::Error::Config(m)) if m == "callback failed"), "{driver}: failed callback = {failed:?}");

    assert!(
        try_exec(db, "INSERT INTO item (title, audit_seq) VALUES ('raw', 999)").await.is_err(),
        "{driver}: the foreign key rejects a raw insert that names no audit record"
    );
    let records = audit_records(db).await;
    assert_eq!(records, [("1".to_owned(), "create".to_owned()), ("2".to_owned(), "default".to_owned())], "{driver}: audit records");
    assert_eq!(
        history_summary(db).await,
        [
            ("insert".to_owned(), None, seq, "first".to_owned(), 1, false),
            ("update".to_owned(), Some(1), seq, "second".to_owned(), 1, false),
            ("update".to_owned(), Some(1), seq, "second".to_owned(), 2, true),
        ],
        "{driver}: history rows"
    );
    adb.close().await;
}

/// Every transaction entry point takes audit values: transaction, transaction_send, and transaction_once take the connection's audit
/// source and their own values, and the key of the audit record they make is written by audit-target writes; a nested transaction_once does not take audit
/// values (CONFIG). The db has audit.dbs installed and its tables are empty.
#[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
pub async fn entry_points_case(driver: &str, dsn: &str) {
    let adb = audit_db(dsn, audit_config("default")).await;
    let db = &adb;
    let seq = adb
        .transaction(async || polyspec_orm::model::create(&mut new_item("first")).await?.value("seq").expect("generated seq").as_i64())
        .audit([("actor", "transaction")])
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: transaction: {e}"));
    adb.transaction_send(|| async { polyspec_orm::model::update(&mut changed_item(seq, "second"), false).await })
        .audit([("actor", "send")])
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: transaction_send: {e}"));
    adb.transaction_once(async || polyspec_orm::model::update(&mut changed_item(seq, "third"), false).await)
        .audit([("actor", "once")])
        .await
        .unwrap_or_else(|e| panic!("{driver}: transaction_once: {e:?}"));
    let without = adb.transaction_once(async || polyspec_orm::model::update(&mut changed_item(seq, "fourth"), false).await).await;
    assert!(
        matches!(&without, Err(polyspec_orm::TransactionOnceError::Callback(e)) if e.code() == polyspec_orm::codes::CONFIG),
        "{driver}: transaction_once without an audit: {without:?}"
    );
    let nested = adb
        .transaction(async || match adb.transaction_once(async || Ok::<(), polyspec_orm::Error>(())).audit([("actor", "nested")]).await {
            Err(polyspec_orm::TransactionOnceError::Orm(e)) => Err::<(), polyspec_orm::Error>(e),
            other => panic!("{driver}: nested transaction_once with an audit: {other:?}"),
        })
        .audit(NO_VALUES)
        .retry(0)
        .await;
    assert_eq!(code(nested), polyspec_orm::codes::CONFIG, "{driver}: a nested transaction_once audit");
    let records = audit_records(db).await;
    let want = [("1", "transaction"), ("2", "send"), ("3", "once")].map(|(s, a)| (s.to_owned(), a.to_owned()));
    assert_eq!(records, want, "{driver}: audit records");
    assert_eq!(
        history_summary(db).await,
        [
            ("insert".to_owned(), None, seq, "first".to_owned(), 1, false),
            ("update".to_owned(), Some(1), seq, "second".to_owned(), 2, false),
            ("update".to_owned(), Some(2), seq, "third".to_owned(), 3, false),
        ],
        "{driver}: history rows"
    );
    adb.close().await;
}
