//! contracts/fixtures/audit.dbs의 item과 item_history를 column 이름으로 읽고 쓰는 model과
//! 그 table을 다루는 도구. audit.rs와 coverage_audit.rs가 함께 쓴다.

use std::collections::BTreeMap;

use orm::db::Pool;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};

pub static SCHEMA: Schema =
    Schema::new(include_str!("../../../../../contracts/fixtures/audit.dbs"), "sha256:2dd3ebcc7657ed4a39437fbd195221f456006745afbc6e957858b5a0b96f1bb2");

/// column 이름으로 값을 읽고 쓰는 model.
macro_rules! row_model {
    ($name:ident, $entity:ident, $entity_name:literal, $columns:expr) => {
        static $entity: Entity =
            Entity { name: $entity_name, schema: &SCHEMA, new: orm::model::new_boxed::<$name>, collect: orm::model::collect_boxed::<$name> };

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
            fn assign(&mut self, name: &str, v: Val) -> orm::Result<bool> {
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

row_model!(Item, ITEM, "item", ["seq", "title", "operation_id", "deleted_at"]);
row_model!(History, HISTORY, "item_history", ["history_id", "change", "previous_operation_id", "seq", "title", "operation_id", "deleted_at"]);

pub fn model<M: Model>() -> M {
    M::from_core(Core::new(M::entity()))
}

pub fn connected<M: Model>(db: &Db) -> M {
    let mut core = Core::new(M::entity());
    core.connect(db);
    M::from_core(core)
}

// coverage_audit_triggers.rs만 쓴다. audit.rs는 자기 case database를 통째로 지운다.
#[allow(dead_code)]
pub async fn exec(db: &Db, statement: &str) {
    let sql = sqlx::raw_sql(sqlx::AssertSqlSafe(statement.to_owned()));
    match db.pool() {
        Pool::MySql(p) => sql.execute(p).await.map(|_| ()),
        Pool::Postgres(p) => sql.execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => sql.execute(p).await.map(|_| ()),
    }
    .unwrap_or_else(|e| panic!("{statement}: {e}"));
}

/// fixture의 table과, PostgreSQL에서는 table과 함께 지워지지 않는 trigger function을 지운다.
/// coverage_audit_triggers.rs만 쓴다.
#[allow(dead_code)]
pub async fn drop_tables(db: &Db, driver: &str) {
    let q = |name: &str| if driver == "mysql" { format!("`{name}`") } else { format!("\"{name}\"") };
    for table in ["item", "item_history"] {
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
    orm::model::gets(&q).await.unwrap().into_vec().into_iter().map(|r| r.values).collect()
}

pub fn code<T>(r: orm::Result<T>) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => e.code().to_owned(),
    }
}

/// 실행 중인 transaction 안에서 operation id를 정하는 case(clients/go/orm/audit_operation_test.go의
/// setOperationCase와 같은 순서). db에는 audit.dbs가 설치되어 있고 item은 비어 있다. 확인하는 것:
///   - transaction 밖의 set_operation은 CONFIG다.
///   - set_operation 전의 audit 대상 write는 CONFIG이고, 그 뒤의 write는 정한 id를 쓴다.
///   - 같은 id를 다시 정하면 바뀌지 않고, 다른 id는 중첩 transaction에서도 CONFIG다.
///   - rollback한 savepoint(transaction과 transaction_once)는 그 안에서 정한 id를 되돌리고, 풀린 savepoint는
///     그 id를 남긴다.
///   - transaction의 operation option으로 정한 id도 같은 규칙을 따른다.
#[allow(dead_code)]
pub async fn set_operation_case(db: &Db, driver: &str) {
    let failed = |what: &str, r: orm::Result<()>| assert_eq!(code(r), orm::codes::CONFIG, "{driver}: {what}");
    failed("set_operation outside a transaction", db.utils().set_operation(1));

    let seq = db
        .transaction(async || {
            failed("an audited insert before set_operation", orm::model::create(&mut new_item("before")).await.map(|_| ()));
            db.utils().set_operation(7)?;
            let seq = orm::model::create(&mut new_item("first")).await?.value("seq").expect("generated seq").as_i64()?;
            db.utils().set_operation(7).map_err(|e| orm::Error::Config(format!("the same operation id again: {e}")))?;
            failed("another operation id", db.utils().set_operation(8));
            db.transaction(async || {
                failed("another operation id in a nested transaction", db.utils().set_operation(9));
                orm::model::update(&mut changed_item(seq, "second"), false).await
            })
            .retry(0)
            .await?;
            Ok(seq)
        })
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: set_operation 7: {e}"));

    db.transaction(async || {
        let nested = db
            .transaction(async || {
                db.utils().set_operation(10)?;
                Err::<(), _>(orm::Error::Config("savepoint rolled back".into()))
            })
            .retry(0)
            .await;
        assert!(matches!(&nested, Err(orm::Error::Config(m)) if m == "savepoint rolled back"), "{driver}: nested transaction = {nested:?}");
        let once = db
            .transaction_once(async || {
                db.utils().set_operation(10).expect("set_operation in transaction_once");
                Err::<(), _>("savepoint rolled back")
            })
            .await;
        assert!(matches!(once, Err(orm::TransactionOnceError::Callback("savepoint rolled back"))), "{driver}: nested transaction_once = {once:?}");
        failed("an audited update after the savepoints that set the id rolled back", orm::model::update(&mut changed_item(seq, "third"), false).await);
        // 풀린 savepoint는 그 안에서 정한 id를 남긴다.
        db.transaction(async || db.utils().set_operation(11)).retry(0).await?;
        orm::model::update(&mut changed_item(seq, "third"), false).await
    })
    .retry(0)
    .await
    .unwrap_or_else(|e| panic!("{driver}: set_operation 11: {e}"));

    db.transaction(async || {
        db.utils().set_operation(12).map_err(|e| orm::Error::Config(format!("the option's operation id again: {e}")))?;
        failed("another id than the option's", db.utils().set_operation(13));
        orm::model::delete(&changed_item(seq, "third"), false).await
    })
    .operation(12)
    .retry(0)
    .await
    .unwrap_or_else(|e| panic!("{driver}: operation 12: {e}"));

    let summary: Vec<(String, Option<i64>, i64, String, i64, bool)> = history(db)
        .await
        .iter()
        .map(|r| {
            let previous = if r["previous_operation_id"].is_null() { None } else { Some(r["previous_operation_id"].as_i64().unwrap()) };
            let text = |column: &str| r[column].as_string().unwrap();
            (text("change"), previous, r["seq"].as_i64().unwrap(), text("title"), r["operation_id"].as_i64().unwrap(), !r["deleted_at"].is_null())
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("insert".to_owned(), None, seq, "first".to_owned(), 7, false),
            ("update".to_owned(), Some(7), seq, "second".to_owned(), 7, false),
            ("update".to_owned(), Some(7), seq, "third".to_owned(), 11, false),
            ("update".to_owned(), Some(11), seq, "third".to_owned(), 12, true),
        ],
        "{driver}: history rows"
    );
}
