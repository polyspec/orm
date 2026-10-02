//! contracts/fixtures/audit.dbspec의 item과 item_history를 column 이름으로 읽고 쓰는 model과
//! 그 table을 다루는 도구. audit.rs와 coverage_audit.rs가 함께 쓴다.

use std::collections::BTreeMap;

use orm::db::Pool;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};

pub static SCHEMA: Schema =
    Schema::new(include_str!("../../../../../contracts/fixtures/audit.dbspec"), "sha256:2dd3ebcc7657ed4a39437fbd195221f456006745afbc6e957858b5a0b96f1bb2");

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
