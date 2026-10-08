//! contracts/fixtures/audit.dbs의 item, item_history, audit을 column 이름으로 읽고 쓰는 model과
//! 그 table을 다루는 도구, audit 기록 transaction case. audit.rs와 coverage_audit_triggers.rs가 함께
//! 쓴다.

use std::collections::BTreeMap;

use polyspec_orm::db::Pool;
use polyspec_orm::{Core, Db, Entity, Model, Param, Schema, Val};
use sqlx::Row;

pub static SCHEMA: Schema =
    Schema::new(include_str!("../../../../../contracts/fixtures/audit.dbs"), "sha256:c651e923992a61fa5712620c7cf6cf7d1a509796b23c4ae597f58e9f561a0c1f");

/// column 이름으로 값을 읽고 쓰는 model.
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

/// audit 값이 없는 transaction의 `.audit(...)` 인자.
#[allow(dead_code)]
pub const NO_VALUES: [(&str, &str); 0] = [];

pub fn model<M: Model>() -> M {
    M::from_core(Core::new(M::entity()))
}

pub fn connected<M: Model>(db: &Db) -> M {
    let mut core = Core::new(M::entity());
    core.connect(db);
    M::from_core(core)
}

/// actor를 audit 값으로 주는 audit source다.
pub fn audit_source(actor: &str) -> polyspec_orm::AuditSource {
    let actor = actor.to_owned();
    std::sync::Arc::new(move || Ok(vec![("actor".to_owned(), Param::from(actor.as_str()))]))
}

/// actor를 audit 값으로 주는 연결 설정이다.
pub fn audit_config(actor: &str) -> polyspec_orm::Config {
    polyspec_orm::Config { audit_source: Some(audit_source(actor)), ..Default::default() }
}

/// dsn에 config로 연결하고 audit.dbs를 등록한다. table이 없으면 설치한다.
pub async fn audit_db(dsn: &str, config: polyspec_orm::Config) -> Db {
    let db = Db::connect(dsn, 2, config).await.unwrap_or_else(|e| panic!("connect: {e}"));
    db.utils().schema().install(&SCHEMA).await.unwrap_or_else(|e| panic!("install: {e}"));
    db
}

/// statement를 실행하고 그 결과를 돌려준다.
pub async fn try_exec(db: &Db, statement: &str) -> Result<(), sqlx::Error> {
    let sql = sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned()));
    match db.pool() {
        Pool::MySql(p) => sql.execute(p).await.map(|_| ()),
        Pool::Postgres(p) => sql.execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => sql.execute(p).await.map(|_| ()),
    }
}

// coverage_audit_triggers.rs만 쓴다. audit.rs는 자기 case database를 통째로 지운다.
#[allow(dead_code)]
pub async fn exec(db: &Db, statement: &str) {
    try_exec(db, statement).await.unwrap_or_else(|e| panic!("{statement}: {e}"));
}

/// fixture의 table과, PostgreSQL에서는 table과 함께 지워지지 않는 trigger function을 지운다.
/// coverage_audit_triggers.rs만 쓴다.
#[allow(dead_code)]
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

/// item_history의 (change, previous, seq, title, audit, deleted)를 history_id 순서로 읽는다.
#[allow(dead_code)]
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

/// audit 기록을 seq 순서의 (seq, actor) 문자열로 읽는다.
#[allow(dead_code)]
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
    }
}

pub fn code<T>(r: polyspec_orm::Result<T>) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => e.code().to_owned(),
    }
}

/// audit 기록을 받은 transaction의 write를 확인한다(packages/orm-go/orm/audit_transaction_test.go의 auditCase와
/// 같은 순서). db에는 audit.dbs가 설치되어 있고 table은 비어 있다. 확인하는 것:
///   - 연결 설정의 audit source가 준 값과 transaction의 audit 값을 합친 기록 하나를 transaction이 callback 전에
///     audit setting의 references table에 삽입하고(같은 column이면 transaction 값이 이긴다), audit table의
///     insert, update, soft delete는 그
///     primary key를 audit column에 쓴다. trigger가 각 version을 history table에 남기고 previous는 이전
///     version의 audit key다.
///   - audit source가 없는 연결의 audit transaction, audit 기록 table의 column이 아닌 값(transaction이나
///     source의 값)은 CONFIG이고, source의 오류는 transaction의 오류다.
///   - 중첩 transaction은 바깥 audit을 쓰며 자기 audit을 받지 않는다(CONFIG).
///   - audit 없는 audit table write는 CONFIG다. 없는 audit 기록을 가리키는 raw write는 foreign key가
///     거부한다.
///   - callback이 실패하면 audit 기록도 rollback된다.
#[allow(dead_code)]
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
            // 중첩 transaction은 바깥 audit을 쓴다.
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
    // 값이 없는 audit transaction은 기본값만으로 기록한다.
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

/// 모든 transaction 진입점이 audit 값을 받는다: transaction, transaction_send, transaction_once가 연결의 audit
/// source와 자기 값으로 기록한 audit의 key를 audit 대상 write가 쓰고, 중첩 transaction_once는 audit을 받지
/// 않는다(CONFIG). db에는 audit.dbs가 설치되어 있고 table은 비어 있다.
#[allow(dead_code)]
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
