//! Audit triggers: log tables from one manifest, audited tables from a second
//! manifest installed on the same connection, and writes inside a transaction
//! that names its operation with set_local, on SQLite, MySQL and PostgreSQL.
//! The test fails when ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.

use orm::db::Pool;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};

/// Returns the DSN in `var`; an unset or empty variable fails the test.
fn require_dsn(var: &str) -> String {
    match std::env::var(var) {
        Ok(dsn) if !dsn.is_empty() => dsn,
        _ => panic!("{var} is required; database tests never skip"),
    }
}

static LOG_SCHEMA: Schema = Schema::new(include_bytes!("testdata/audit_log.json"), "2224506956429dd0");
static ITEM_SCHEMA: Schema = Schema::new(include_bytes!("testdata/audit_item.json"), "d156b54c9f792507");
static LOG_PLAIN_SCHEMA: Schema = Schema::new(include_bytes!("testdata/audit_log_plain.json"), "e13f02f8e6ffeaeb");
static ITEM_PLAIN_SCHEMA: Schema = Schema::new(include_bytes!("testdata/audit_item_plain.json"), "826284c989a0a7a8");

/// A model whose values are read and written by column name.
macro_rules! row_model {
    ($name:ident, $entity:ident, $entity_name:literal, $schema:expr, $columns:expr) => {
        static $entity: Entity = Entity { name: $entity_name, schema: $schema, new: orm::model::new_boxed::<$name>, collect: orm::model::collect_boxed::<$name> };

        #[derive(Clone)]
        struct $name {
            core: Core,
            values: std::collections::BTreeMap<String, Val>,
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
                $name { core, values: std::collections::BTreeMap::new() }
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

const CHANGE_COLUMNS: &[&str] = &["seq", "operation_seq", "change_kind", "service_ref", "table_label", "entity_ref", "before_value", "after_value"];

row_model!(Operation, OPERATION, "audit_operation", &LOG_SCHEMA, ["seq", "operation_uuid"]);
row_model!(Change, CHANGE, "audit_change", &LOG_SCHEMA, CHANGE_COLUMNS);
row_model!(Item, ITEM, "audit_item", &ITEM_SCHEMA, ["seq", "service_ref", "title"]);
row_model!(PlainOperation, PLAIN_OPERATION, "audit_operation", &LOG_PLAIN_SCHEMA, ["seq", "operation_uuid"]);
row_model!(PlainChange, PLAIN_CHANGE, "audit_change", &LOG_PLAIN_SCHEMA, CHANGE_COLUMNS);
row_model!(PlainItem, PLAIN_ITEM, "audit_item", &ITEM_PLAIN_SCHEMA, ["seq", "service_ref", "title"]);

fn model<M: Model>() -> M {
    M::from_core(Core::new(M::entity()))
}

fn connected<M: Model>(db: &Db) -> M {
    let mut core = Core::new(M::entity());
    core.connect(db);
    M::from_core(core)
}

async fn exec(db: &Db, statement: &'static str) {
    let sql = sqlx::raw_sql(statement);
    match db.pool() {
        Pool::MySql(p) => sql.execute(p).await.map(|_| ()),
        Pool::Postgres(p) => sql.execute(p).await.map(|_| ()),
        Pool::Sqlite(p) => sql.execute(p).await.map(|_| ()),
    }
    .unwrap_or_else(|e| panic!("{statement}: {e}"));
}

async fn drop_tables(db: &Db, driver: &str) {
    let statements: &[&'static str] = match driver {
        "postgres" => &["DROP SCHEMA IF EXISTS app CASCADE"],
        "mysql" => &["DROP TABLE IF EXISTS `audit_item`", "DROP TABLE IF EXISTS `audit_change`", "DROP TABLE IF EXISTS `audit_operation`"],
        _ => &[
            r#"DROP TABLE IF EXISTS "app__audit_item""#,
            r#"DROP TABLE IF EXISTS "app__audit_change""#,
            r#"DROP TABLE IF EXISTS "app__audit_operation""#,
        ],
    };
    for statement in statements {
        exec(db, statement).await;
    }
}

#[tokio::test]
async fn audit_triggers() {
    let tmp = std::env::temp_dir().join(format!("orm-rust-audit-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let mysql_dsn = require_dsn("ORM_TEST_MYSQL_DSN");
    let postgres_dsn = require_dsn("ORM_TEST_POSTGRES_DSN");
    let targets = vec![
        ("sqlite".to_owned(), format!("sqlite://{}", tmp.join("audit.sqlite").display())),
        ("mysql".to_owned(), mysql_dsn),
        ("postgres".to_owned(), postgres_dsn),
    ];
    for (driver, dsn) in &targets {
        let plain = driver == "mysql";
        let db = Db::connect(dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
        drop_tables(&db, driver).await;
        let (log_json, item_json) = if plain { (LOG_PLAIN_SCHEMA.json(), ITEM_PLAIN_SCHEMA.json()) } else { (LOG_SCHEMA.json(), ITEM_SCHEMA.json()) };
        for json in [log_json, item_json, item_json] {
            db.utils().schema().install(json).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
        }
        let table_label = if plain { "audit_item" } else { "app.audit_item" };

        let without_operation = db
            .transaction(async || {
                if plain {
                    let mut row: PlainItem = model();
                    row.core_mut().set("service_ref", Param::from("s1"));
                    row.core_mut().set("title", Param::from("a"));
                    orm::model::create(&mut row).await.map(|_| ())
                } else {
                    let mut row: Item = model();
                    row.core_mut().set("service_ref", Param::from("s1"));
                    row.core_mut().set("title", Param::from("a"));
                    orm::model::create(&mut row).await.map(|_| ())
                }
            })
            .await;
        let message = without_operation.expect_err("write without an operation").to_string();
        assert!(message.contains("audit operation context is required"), "{driver}: {message}");

        let seq: i64 = db
            .transaction(async || {
                if plain {
                    let mut op: PlainOperation = model();
                    op.core_mut().set("operation_uuid", Param::from("op-1"));
                    orm::model::create(&mut op).await?;
                    db.utils().set_local("app.operation_id", "op-1").await?;
                    let mut row: PlainItem = model();
                    row.core_mut().set("service_ref", Param::from("s1"));
                    row.core_mut().set("title", Param::from("a"));
                    let created = orm::model::create(&mut row).await?;
                    let seq = created.value("seq").unwrap_or_default().as_i64();
                    let mut changed: PlainItem = model();
                    changed.core_mut().set("seq", Param::I64(seq));
                    changed.core_mut().set("title", Param::from("b"));
                    orm::model::update(&mut changed, false).await?;
                    Ok(seq)
                } else {
                    let mut op: Operation = model();
                    op.core_mut().set("operation_uuid", Param::from("op-1"));
                    orm::model::create(&mut op).await?;
                    db.utils().set_local("app.operation_id", "op-1").await?;
                    let mut row: Item = model();
                    row.core_mut().set("service_ref", Param::from("s1"));
                    row.core_mut().set("title", Param::from("a"));
                    let created = orm::model::create(&mut row).await?;
                    let seq = created.value("seq").unwrap_or_default().as_i64();
                    let mut changed: Item = model();
                    changed.core_mut().set("seq", Param::I64(seq));
                    changed.core_mut().set("title", Param::from("b"));
                    orm::model::update(&mut changed, false).await?;
                    Ok(seq)
                }
            })
            .await
            .unwrap_or_else(|e| panic!("{driver}: audited writes: {e}"));

        let rows: Vec<std::collections::BTreeMap<String, Val>> = if plain {
            let mut q: PlainChange = connected(&db);
            q.core_mut().add_all_columns();
            q.core_mut().order_by("seq", false, None);
            orm::model::gets(&q).await.unwrap().into_vec().into_iter().map(|r| r.values).collect()
        } else {
            let mut q: Change = connected(&db);
            q.core_mut().add_all_columns();
            q.core_mut().order_by("seq", false, None);
            orm::model::gets(&q).await.unwrap().into_vec().into_iter().map(|r| r.values).collect()
        };
        let text = |row: &std::collections::BTreeMap<String, Val>, column: &str| row[column].as_string();
        let json = |row: &std::collections::BTreeMap<String, Val>, column: &str| row[column].to_json().to_string();
        assert_eq!(rows.len(), 2, "{driver}: change rows");
        assert_eq!(rows.iter().map(|r| text(r, "change_kind")).collect::<Vec<_>>(), ["INSERT", "UPDATE"], "{driver}: change kinds");
        for row in &rows {
            assert_eq!(row["operation_seq"].as_i64(), 1, "{driver}: operation");
            assert_eq!(text(row, "service_ref"), "s1", "{driver}: site");
            assert_eq!(text(row, "table_label"), table_label, "{driver}: table");
            assert_eq!(json(row, "entity_ref"), format!("{{\"seq\":{seq}}}"), "{driver}: entity key");
        }
        assert_eq!(json(&rows[1], "before_value"), "{\"title\":\"a\"}", "{driver}: before");
        assert_eq!(json(&rows[1], "after_value"), "{\"title\":\"b\"}", "{driver}: after");

        drop_tables(&db, driver).await;
        db.close().await;
    }
    let _ = std::fs::remove_dir_all(&tmp);
}
