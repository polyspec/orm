//! add_columns on SQLite, MySQL and PostgreSQL. A database holds the audit log
//! tables of one manifest and the tables of a module manifest at version 1,
//! with rows. add_columns with version 2 adds the missing nullable and
//! defaulted columns to the existing module tables, keeps the rows, replaces
//! the audit triggers of the changed table so that they record the new
//! columns, creates no missing table and leaves the tables of the log manifest
//! unchanged; a repeated call adds nothing. A manifest that differs from the
//! tables in any other way fails with SCHEMA_DIFFERS before any change. The
//! fixtures are contracts/fixtures/add_columns_*.json. The test fails when
//! ORM_TEST_MYSQL_DSN or ORM_TEST_POSTGRES_DSN is unset.

use std::collections::BTreeMap;

use orm::core::{Arg, ChainKey};
use orm::db::Pool;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};

static LOG: Schema = Schema::new(include_bytes!("../../../../contracts/fixtures/add_columns_log.json"), "106a65e9f57ac6d9");
static V1: Schema = Schema::new(include_bytes!("../../../../contracts/fixtures/add_columns_v1.json"), "88d76d8071863a19");
static V2: Schema = Schema::new(include_bytes!("../../../../contracts/fixtures/add_columns_v2.json"), "d58d0cc0157386cd");
const DIFFERS: [(&str, &[u8]); 7] = [
    ("required", include_bytes!("../../../../contracts/fixtures/add_columns_required.json")),
    ("removed", include_bytes!("../../../../contracts/fixtures/add_columns_removed.json")),
    ("changed", include_bytes!("../../../../contracts/fixtures/add_columns_changed.json")),
    ("nullable", include_bytes!("../../../../contracts/fixtures/add_columns_nullable.json")),
    ("default", include_bytes!("../../../../contracts/fixtures/add_columns_default.json")),
    ("index", include_bytes!("../../../../contracts/fixtures/add_columns_index.json")),
    ("unique", include_bytes!("../../../../contracts/fixtures/add_columns_unique.json")),
];
const ADDED: [&str; 5] = ["addcol_item.note", "addcol_item.rank", "addcol_item.archived", "addcol_item.status", "addcol_tag.color"];
const ITEM_V1: &[&str] = &["seq", "uuid", "label", "enabled", "price", "created_at"];
const ITEM_V2: &[&str] = &["seq", "uuid", "label", "enabled", "price", "created_at", "note", "rank", "archived", "status"];
const CHANGE: &[&str] = &["seq", "addcol_operation_seq", "change_kind", "service_seq", "table_label", "entity_ref", "before_value", "after_value"];

/// A model whose values are read and written by column name.
macro_rules! row_model {
    ($name:ident, $entity:ident, $entity_name:literal, $schema:expr, $columns:expr) => {
        static $entity: Entity =
            Entity { name: $entity_name, schema: $schema, new: orm::model::new_boxed::<$name>, collect: orm::model::collect_boxed::<$name> };

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

row_model!(Operation, OPERATION, "addcol_operation", &LOG, ["seq", "operation_uuid"]);
row_model!(Change, CHANGE_ENTITY, "addcol_change", &LOG, CHANGE);
row_model!(ItemV1, ITEM_V1_ENTITY, "addcol_item", &V1, ITEM_V1);
row_model!(TagV1, TAG_V1, "addcol_tag", &V1, ["seq", "addcol_item_seq", "parent_addcol_tag_seq", "name"]);
row_model!(ItemV2, ITEM_V2_ENTITY, "addcol_item", &V2, ITEM_V2);
row_model!(TagV2, TAG_V2, "addcol_tag", &V2, ["seq", "addcol_item_seq", "parent_addcol_tag_seq", "name", "color"]);
row_model!(ExtraV2, EXTRA_V2, "addcol_extra", &V2, ["seq", "label"]);

fn connected<M: Model>(db: &Db) -> M {
    let mut core = Core::new(M::entity());
    core.connect(db);
    M::from_core(core)
}

/// Serializes the cases, which share the tables of the MySQL and PostgreSQL test databases.
static TABLES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn targets() -> Vec<(&'static str, String)> {
    let dir = std::env::temp_dir().join(format!("orm-rust-add-columns-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("add-columns.sqlite");
    let _ = std::fs::remove_file(&path);
    let mut out = vec![("sqlite", format!("sqlite://{}", path.display()))];
    for driver in ["mysql", "postgres"] {
        let var = format!("ORM_TEST_{}_DSN", driver.to_uppercase());
        match std::env::var(&var) {
            Ok(dsn) if !dsn.is_empty() => out.push((driver, dsn)),
            _ => panic!("{var} is required; database tests never skip"),
        }
    }
    out
}

async fn drop_tables(db: &Db, driver: &str) {
    let mut statements: Vec<String> = ["addcol_extra", "addcol_tag", "addcol_item", "addcol_change", "addcol_operation"]
        .iter()
        .map(|t| if driver == "mysql" { format!("DROP TABLE IF EXISTS `{t}`") } else { format!(r#"DROP TABLE IF EXISTS "{t}""#) })
        .collect();
    if driver == "postgres" {
        statements.push("DROP FUNCTION IF EXISTS addcol_item_audit()".into());
    }
    for statement in statements {
        let sql = sqlx::raw_sql(sqlx::AssertSqlSafe(statement.clone()));
        match db.pool() {
            Pool::MySql(p) => sql.execute(p).await.map(|_| ()),
            Pool::Postgres(p) => sql.execute(p).await.map(|_| ()),
            Pool::Sqlite(p) => sql.execute(p).await.map(|_| ()),
        }
        .unwrap_or_else(|e| panic!("{driver}: {statement}: {e}"));
    }
}

/// Opens a connection, installs the log and version 1 with one item and one tag.
async fn installed(driver: &str, dsn: &str) -> Db {
    let db = Db::connect(dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: {e}"));
    drop_tables(&db, driver).await;
    for json in [LOG.json(), V1.json()] {
        db.utils().schema().install(json).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    }
    db.transaction(async || {
        let mut op: Operation = connected(&db);
        op.core_mut().set("operation_uuid", Param::from("op-1"));
        orm::model::create(&mut op).await?;
        db.utils().set_local("addcol.operation", "op-1").await?;
        let mut item: ItemV1 = connected(&db);
        item.core_mut().set("uuid", Param::from("item-1"));
        item.core_mut().set("label", Param::from("first"));
        item.core_mut().set("enabled", Param::Bool(true));
        let created = orm::model::create(&mut item).await?;
        let seq = created.value("seq").expect("generated seq").as_i64()?;
        let mut tag: TagV1 = connected(&db);
        tag.core_mut().set("addcol_item_seq", Param::I64(seq));
        tag.core_mut().set("name", Param::from("red"));
        orm::model::create(&mut tag).await.map(|_| ())
    })
    .await
    .unwrap_or_else(|e| panic!("{driver}: version 1 rows: {e}"));
    db
}

/// The kind and after value of each audit change in order.
async fn changes(db: &Db, driver: &str) -> Vec<String> {
    let mut q: Change = connected(db);
    q.core_mut().add_all_columns();
    q.core_mut().order_by("seq", false, None);
    let rows = orm::model::gets(&q).await.unwrap_or_else(|e| panic!("{driver}: changes: {e}"));
    rows.into_vec().into_iter().map(|r| format!("{} {}", r.values["change_kind"].as_string().unwrap(), r.values["after_value"].to_json().unwrap())).collect()
}

/// The number of rows of version 2 items that match the column values.
async fn item_count(db: &Db, columns: &[(&'static str, Param)]) -> i64 {
    let keys: Vec<ChainKey> = columns
        .iter()
        .enumerate()
        .map(|(i, (column, _))| ChainKey { conn: if i == 0 { "" } else { "and" }, op: "", column, columns: &[], compare: "" })
        .collect();
    let args = columns.iter().map(|(_, value)| Arg::Value(orm::args::Value::One(value.clone()))).collect();
    let item: ItemV2 = connected(db);
    orm::model::get_count(&item.core().by(&keys, args)).await.unwrap()
}

#[tokio::test]
async fn add_columns() {
    let _tables = TABLES.lock().await;
    for (driver, dsn) in targets() {
        let db = installed(driver, &dsn).await;
        let before = changes(&db, driver).await;
        assert_eq!(before.len(), 1, "{driver}: changes before {before:?}");
        let added = db.utils().schema().add_columns(V2.json()).await.unwrap_or_else(|e| panic!("{driver}: add_columns: {e}"));
        assert_eq!(added, ADDED, "{driver}: added columns");
        assert_eq!(item_count(&db, &[("label", Param::from("first")), ("enabled", Param::Bool(true))]).await, 1, "{driver}: item values kept");
        assert_eq!(
            item_count(&db, &[("rank", Param::I64(3)), ("archived", Param::Bool(false)), ("status", Param::from("new"))]).await,
            1,
            "{driver}: item defaults"
        );
        let mut q: ItemV2 = connected(&db);
        q.core_mut().add_all_columns();
        let items = orm::model::gets(&q).await.unwrap().into_vec();
        assert_eq!(items.len(), 1, "{driver}: one item");
        assert_eq!(items[0].values["note"], Val::Null, "{driver}: note");
        let seq = items[0].values["seq"].as_i64().unwrap();
        let mut q: TagV2 = connected(&db);
        q.core_mut().add_all_columns();
        let tags = orm::model::gets(&q).await.unwrap().into_vec();
        assert_eq!(tags.len(), 1, "{driver}: one tag");
        assert_eq!(tags[0].values["name"].as_string().unwrap(), "red", "{driver}: tag name");
        assert_eq!(tags[0].values["color"], Val::Null, "{driver}: tag color");
        assert_eq!(changes(&db, driver).await, before, "{driver}: log rows kept");
        db.transaction(async || {
            let mut op: Operation = connected(&db);
            op.core_mut().set("operation_uuid", Param::from("op-2"));
            orm::model::create(&mut op).await?;
            db.utils().set_local("addcol.operation", "op-2").await?;
            let mut item: ItemV2 = connected(&db);
            item.core_mut().set("seq", Param::I64(seq));
            item.core_mut().set("note", Param::from("later"));
            item.core_mut().set("rank", Param::I64(4));
            orm::model::update(&mut item, false).await
        })
        .await
        .unwrap_or_else(|e| panic!("{driver}: audited update: {e}"));
        let after = changes(&db, driver).await;
        assert_eq!(after.len(), 2, "{driver}: changes after {after:?}");
        assert_eq!(after[1], r#"UPDATE {"note":"later","rank":4}"#, "{driver}: update change");
        let extra: ExtraV2 = connected(&db);
        let missing = orm::model::get_count(extra.core()).await.expect_err("the missing table");
        assert_eq!(missing.code(), orm::codes::DRIVER, "{driver}: the missing table is not created: {missing}");
        assert!(db.utils().schema().add_columns(V2.json()).await.unwrap().is_empty(), "{driver}: repeated add_columns");
        db.utils().schema().install(V2.json()).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
        let extra: ExtraV2 = connected(&db);
        assert_eq!(orm::model::get_count(extra.core()).await.unwrap(), 0, "{driver}: install creates the missing table");
        assert!(db.utils().schema().add_columns(V2.json()).await.unwrap().is_empty(), "{driver}: add_columns after install");
        drop_tables(&db, driver).await;
        db.close().await;
    }
}

#[tokio::test]
async fn add_columns_differs() {
    let _tables = TABLES.lock().await;
    for (driver, dsn) in targets() {
        let db = installed(driver, &dsn).await;
        for (name, json) in DIFFERS {
            let error = db.utils().schema().add_columns(json).await.expect_err(name);
            assert_eq!(error.code(), orm::codes::SCHEMA_DIFFERS, "{driver}: {name}: {error}");
        }
        assert_eq!(db.utils().schema().add_columns(V2.json()).await.unwrap(), ADDED, "{driver}: no column was added before");
        drop_tables(&db, driver).await;
        db.close().await;
    }
}

#[tokio::test]
async fn add_columns_transaction() {
    let _tables = TABLES.lock().await;
    for (driver, dsn) in targets() {
        let db = installed(driver, &dsn).await;
        let inside = db
            .transaction(async || {
                db.utils()
                    .schema()
                    .add_columns(V2.json())
                    .await
                    .map(|added| assert_eq!(added, ADDED, "{driver}: added in the transaction"))
                    .and(Err::<(), _>(orm::Error::Config("roll back".into())))
            })
            .await;
        let error = inside.expect_err("the transaction fails");
        if driver == "mysql" {
            assert!(error.to_string().contains("MySQL commits schema statements implicitly"), "{driver}: {error}");
        } else {
            assert_eq!(error.to_string(), "CONFIG: roll back", "{driver}: callback error");
        }
        assert_eq!(db.utils().schema().add_columns(V2.json()).await.unwrap(), ADDED, "{driver}: the transaction added no column");
        drop_tables(&db, driver).await;
        db.close().await;
    }
}

#[tokio::test]
async fn add_columns_edited_manifest() {
    let _tables = TABLES.lock().await;
    for (driver, dsn) in targets() {
        let db = installed(driver, &dsn).await;
        let edited = String::from_utf8(V2.json().to_vec()).unwrap().replace(r#""note""#, r#""memo""#);
        let error = db.utils().schema().add_columns(edited.as_bytes()).await.expect_err("edited manifest");
        assert_eq!(error.code(), orm::codes::CONFIG, "{driver}: {error}");
        assert_eq!(db.utils().schema().add_columns(V2.json()).await.unwrap(), ADDED, "{driver}: the edited manifest added no column");
        drop_tables(&db, driver).await;
        db.close().await;
    }
}
