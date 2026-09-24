//! Audit service value: the change table's service column is bigint, an
//! audited entity with service= records its bigint value, an entity without it
//! records NULL, and an enum column with a default installs, on SQLite, MySQL
//! and PostgreSQL. The test fails when ORM_TEST_MYSQL_DSN or
//! ORM_TEST_POSTGRES_DSN is unset.

use std::collections::BTreeMap;

use orm::db::Pool;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};

/// Returns the DSN in `var`; an unset or empty variable fails the test.
fn require_dsn(var: &str) -> String {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; database tests never skip"),
    }
}

// audit_operation, audit_change (bigint service_seq), routed (bigint
// service_seq, enum(csr_ssr) render "=ssr") and unowned, with routed audited
// with service=service_seq and unowned audited without service.
static SCHEMA: Schema = Schema::new(include_bytes!("testdata/audit_service.json"), "fc2e5c2b40971e6d");

/// A model whose values are read and written by column name.
macro_rules! row_model {
    ($name:ident, $entity:ident, $entity_name:literal, $columns:expr) => {
        static $entity: Entity = Entity { name: $entity_name, schema: &SCHEMA, new: orm::model::new_boxed::<$name>, collect: orm::model::collect_boxed::<$name> };

        #[derive(Clone)]
        struct $name {
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
            fn assign(&mut self, name: &str, v: Val) -> bool {
                if !$columns.contains(&name) {
                    return false;
                }
                self.values.insert(name.to_owned(), v);
                true
            }
            fn value(&self, name: &str) -> Option<Val> {
                self.values.get(name).cloned()
            }
        }
    };
}

row_model!(Operation, OPERATION, "audit_operation", ["seq", "operation_uuid"]);
row_model!(Change, CHANGE, "audit_change", ["seq", "operation_seq", "change_kind", "service_seq", "table_label", "entity_ref", "before_value", "after_value"]);
row_model!(Routed, ROUTED, "routed", ["seq", "service_seq", "render"]);
row_model!(Unowned, UNOWNED, "unowned", ["seq", "label"]);

fn model<M: Model>() -> M {
    M::from_core(Core::new(M::entity()))
}

async fn drop_tables(db: &Db) {
    for table in ["routed", "unowned", "audit_change", "audit_operation"] {
        let statement = format!("DROP TABLE IF EXISTS {table}");
        let sql = sqlx::raw_sql(sqlx::AssertSqlSafe(statement));
        match db.pool() {
            Pool::MySql(p) => sql.execute(p).await.map(|_| ()),
            Pool::Postgres(p) => sql.execute(p).await.map(|_| ()),
            Pool::Sqlite(p) => sql.execute(p).await.map(|_| ()),
        }
        .unwrap();
    }
}

#[tokio::test]
async fn audit_bigint_service() {
    let tmp = std::env::temp_dir().join(format!("orm-rust-audit-service-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let targets = [
        ("sqlite", format!("sqlite://{}", tmp.join("audit-service.sqlite").display())),
        ("mysql", require_dsn("ORM_TEST_MYSQL_DSN")),
        ("postgres", require_dsn("ORM_TEST_POSTGRES_DSN")),
    ];
    for (driver, dsn) in &targets {
        let db = Db::connect(dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
        drop_tables(&db).await;
        db.utils().schema().install(SCHEMA.json()).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
        db.transaction(async || {
            let mut op: Operation = model();
            op.core_mut().set("operation_uuid", Param::from("op-1"));
            orm::model::create(&mut op).await?;
            db.utils().set_local("app.operation_id", "op-1").await?;
            let mut routed: Routed = model();
            routed.core_mut().set("service_seq", Param::I64(42));
            orm::model::create(&mut routed).await?;
            let mut unowned: Unowned = model();
            unowned.core_mut().set("label", Param::from("a"));
            orm::model::create(&mut unowned).await.map(|_| ())
        })
        .await
        .unwrap_or_else(|e| panic!("{driver}: audited writes: {e}"));

        let mut q: Change = model();
        q.core_mut().connect(&db);
        q.core_mut().add_all_columns();
        q.core_mut().order_by("seq", false, None);
        let rows: Vec<BTreeMap<String, Val>> = orm::model::gets(&q).await.unwrap().into_vec().into_iter().map(|r| r.values).collect();
        let got: Vec<String> = rows
            .iter()
            .map(|r| {
                let service = match &r["service_seq"] {
                    Val::Null => "null".to_owned(),
                    v => v.as_i64().to_string(),
                };
                format!("{}:{service}", r["table_label"].as_string())
            })
            .collect();
        assert_eq!(got, ["routed:42", "unowned:null"], "{driver}: changes");
        assert_eq!(rows[0]["after_value"].to_json()["render"], "ssr", "{driver}: render default");

        drop_tables(&db).await;
        db.close().await;
    }
    std::fs::remove_dir_all(&tmp).unwrap();
}
