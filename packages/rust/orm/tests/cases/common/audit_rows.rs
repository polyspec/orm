//! The model that reads and writes the item, item_history, and audit tables of contracts/fixtures/audit.dbs by column name, and
//! the helpers that work with those tables, and the audit record transaction case. audit.rs and coverage_audit_triggers.rs
//! both use them.

use crate::or_panic::OrPanic;
use polyspec_orm_test_support::model_row;

use crate::map_rows;

use std::collections::BTreeMap;

use polyspec_orm::{Core, Db, Entity, Model, Param, Schema, Val};
pub static SCHEMA: Schema =
    Schema::new(include_str!("../../../../../../contracts/fixtures/audit.dbs"), "sha256:c651e923992a61fa5712620c7cf6cf7d1a509796b23c4ae597f58e9f561a0c1f");

static ITEM: Entity =
    Entity { name: "item", schema: &SCHEMA, new: polyspec_orm::model::new_boxed::<Item>, collect: polyspec_orm::model::collect_boxed::<Item> };
model_row!(Item, ITEM, ["seq", "title", "audit_seq", "deleted_at"]);
static HISTORY: Entity =
    Entity { name: "item_history", schema: &SCHEMA, new: polyspec_orm::model::new_boxed::<History>, collect: polyspec_orm::model::collect_boxed::<History> };
model_row!(History, HISTORY, ["history_id", "change", "previous_audit_seq", "seq", "title", "audit_seq", "deleted_at"]);

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
    let db = Db::connect(dsn, 2, config).await.or_panic(|e| format!("connect: {e}"));
    db.utils().schema().install(&SCHEMA).await.or_panic(|e| format!("install: {e}"));
    db
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
            let rows = sqlx::raw_sql(sqlx::AssertSqlSafe(query.to_owned())).fetch_all($pool).await.or_panic(|e| format!("{query}: {e}"));
            map_rows::map_rows(&rows, |row| {
                let (sequence, label) = map_rows::sequence_label(row).unwrap();
                (sequence.to_string(), label)
            })
        }};
    }
    map_rows::for_sql_pools!(db.pool(), read)
}

/// A transaction takes audit values: the connection's audit source and its own values, and the key of the audit record it
/// makes is written by audit-target writes through its handle (INT-44, CORE-20). A transaction with no audit values that
/// writes an audited table fails with config. The db has audit.dbs installed and its tables are empty.
#[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
pub async fn entry_points_case(driver: &str, dsn: &str) {
    let adb = audit_db(dsn, audit_config("default")).await;
    let db = &adb;
    let options = |actor: Option<&str>| polyspec_orm::TransactionOptions {
        retry: Some(0),
        audit: actor.map(|actor| vec![("actor".to_owned(), polyspec_orm::Param::from(actor))]),
        ..Default::default()
    };
    let seq = adb
        .transaction(
            |tx: polyspec_orm::Tx| async move {
                let mut item = new_item("first");
                item.core_mut().connect(&tx);
                polyspec_orm::model::create(&mut item).await?.value("seq").expect("generated seq").as_i64()
            },
            options(Some("transaction")),
        )
        .await
        .or_panic(|e| format!("{driver}: transaction: {e}"));
    for (title, actor) in [("second", "send"), ("third", "once")] {
        adb.transaction(
            |tx: polyspec_orm::Tx| async move {
                let mut item = changed_item(seq, title);
                item.core_mut().connect(&tx);
                polyspec_orm::model::update(&mut item, false).await
            },
            options(Some(actor)),
        )
        .await
        .or_panic(|e| format!("{driver}: transaction {actor}: {e}"));
    }
    let without = adb
        .transaction(
            |tx: polyspec_orm::Tx| async move {
                let mut item = changed_item(seq, "fourth");
                item.core_mut().connect(&tx);
                polyspec_orm::model::update(&mut item, false).await
            },
            options(None),
        )
        .await;
    assert!(matches!(&without, Err(e) if e.kind() == polyspec_orm::Kind::Config), "{driver}: a transaction without an audit: {without:?}");
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
