//! The model that reads and writes the membership and label of contracts/fixtures/restore.dbs by column name, and the
//! case that restores soft-deleted rows (in the same order as restoreCase in packages/go/orm/restore_test.go). restore.rs and
//! coverage_audit_triggers.rs both use it.

use std::collections::BTreeMap;

use polyspec_orm::db::Pool;
use polyspec_orm::{Core, Db, Entity, Model, Param, Schema, Val};
use sqlx::Row;

pub static SCHEMA: Schema =
    Schema::new(include_str!("../../../../../contracts/fixtures/restore.dbs"), "sha256:a00c2b376b166195f8aabc29de2a2dee20313e5d9d253eeb4f601f55e9ba0aaf");

/// The tables the restore fixture creates.
#[allow(dead_code, reason = "tests/common is compiled into each test crate, and not every crate uses this item")]
pub const TABLES: [&str; 4] = ["audit", "label", "membership", "membership_history"];

/// A model that reads and writes values by column name.
macro_rules! row_model {
    ($name:ident, $entity:ident, $entity_name:literal, $columns:expr) => {
        static $entity: Entity =
            Entity { name: $entity_name, schema: &SCHEMA, new: polyspec_orm::model::new_boxed::<$name>, collect: polyspec_orm::model::collect_boxed::<$name> };

        #[derive(Clone)]
        pub struct $name {
            core: Core,
            pub values: BTreeMap<String, Val>,
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

row_model!(Membership, MEMBERSHIP, "membership", ["seq", "team_id", "member_id", "note", "audit_seq", "deleted_at"]);
row_model!(Label, LABEL, "label", ["id", "name", "color", "deleted_at"]);

/// A model that is connected and has its values set.
fn with<M: Model>(db: &Db, values: &[(&str, Param)]) -> M {
    let mut core = Core::new(M::entity());
    core.connect(db);
    for (column, value) in values {
        core.set(column, value.clone());
    }
    M::from_core(core)
}

fn code<T>(r: polyspec_orm::Result<T>) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => e.code().to_owned(),
    }
}

/// The name-ordered notation of model values. The MySQL driver returns text as bytes, so UTF-8 bytes are written as strings.
fn shown(values: &BTreeMap<String, Val>) -> String {
    let text: BTreeMap<&String, Val> = values
        .iter()
        .map(|(k, v)| match v {
            Val::Bytes(b) => (k, String::from_utf8(b.clone()).map(Val::Str).unwrap_or_else(|_| v.clone())),
            _ => (k, v.clone()),
        })
        .collect();
    format!("{text:?}")
}

/// Reads the rows of a query. Each value is a string or NULL, and NULL is "NULL".
pub async fn text_rows(db: &Db, query: &str) -> Vec<Vec<String>> {
    macro_rules! read {
        ($pool:expr) => {{
            let rows = sqlx::raw_sql(sqlx::AssertSqlSafe(query.to_owned())).fetch_all($pool).await.unwrap_or_else(|e| panic!("{query}: {e}"));
            rows.iter()
                .map(|r| {
                    (0..r.len())
                        .map(|i| r.try_get::<Option<String>, _>(i).unwrap_or_else(|e| panic!("{query}: {e}")).unwrap_or_else(|| "NULL".to_owned()))
                        .collect()
                })
                .collect()
        }};
    }
    match db.pool() {
        Pool::MySql(p) => read!(p),
        Pool::Postgres(p) => read!(p),
        Pool::Sqlite(p) => read!(p),
        Pool::Markdown(_) => unreachable!("these cases run on SQL databases"),
    }
}

/// A SQL expression that reads a column as text.
fn cast_text(driver: &str, column: &str) -> String {
    if driver == "mysql" {
        format!("CAST({column} AS CHAR)")
    } else {
        format!("CAST({column} AS TEXT)")
    }
}

/// Installs restore.dbs in the dsn's database and restores soft-deleted rows. membership has a unique key
/// (team_id, member_id) and an exclude (note), as an audit table, and label is a table without audit that has a unique key (name),
/// table. It checks:
///   - the unique key values of soft-deleted rows remain, so inserting the same key is DUPLICATE_KEY.
///   - the default read does not read deleted rows.
///   - restore finds the deleted row by the set values of one primary key or unique key and writes the soft delete column as NULL,
///     via an update, and returns the restored row. On an audit table it writes the transaction's audit record key, and the trigger
///     records that update; without audit it is CONFIG.
///   - restoring a row that is not deleted writes nothing and returns that row; restoring a row that does not exist is NO_ROWS.
///   - set values outside the key are new values written to the restored row, and are not written to rows that are not deleted.
///   - a restore with no key value and a restore with no set values are IR_INVALID without any statement.
pub async fn restore_case(driver: &str, dsn: &str) {
    let source: polyspec_orm::AuditSource = std::sync::Arc::new(|| Ok(vec![("actor".to_owned(), Param::from("default"))]));
    let db = Db::connect(dsn, 2, polyspec_orm::Config { audit_source: Some(source), ..Default::default() })
        .await
        .unwrap_or_else(|e| panic!("{driver}: connect: {e}"));
    db.utils().schema().install(&SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    let i = Param::I64;
    let text = |s: &str| Param::Str(s.to_owned());
    let adb = &db;
    let (seq, id) = adb
        .transaction(async || {
            let m = polyspec_orm::model::create(&mut with::<Membership>(&db, &[("team_id", i(1)), ("member_id", i(2)), ("note", text("n1"))])).await?;
            let seq = m.value("seq").expect("generated seq").as_i64()?;
            let l = polyspec_orm::model::create(&mut with::<Label>(&db, &[("name", text("red")), ("color", text("x"))])).await?;
            Ok((seq, l.value("id").expect("generated id").as_i64()?))
        })
        .audit([("actor", "create")])
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: create: {e}"));
    adb.transaction(async || {
        polyspec_orm::model::delete(&with::<Membership>(&db, &[("seq", i(seq))]), false).await?;
        polyspec_orm::model::delete(&with::<Label>(&db, &[("id", i(id))]), false).await
    })
    .audit([("actor", "delete")])
    .retry(0)
    .await
    .unwrap_or_else(|e| panic!("{driver}: delete: {e}"));

    let duplicate = adb
        .transaction(async || polyspec_orm::model::create(&mut with::<Membership>(&db, &[("team_id", i(1)), ("member_id", i(2))])).await.map(|_| ()))
        .audit([("actor", "duplicate")])
        .retry(0)
        .await;
    assert_eq!(code(duplicate), polyspec_orm::codes::DUPLICATE_KEY, "{driver}: insert of the key of a soft-deleted row");
    let mut read: Label = with(&db, &[]);
    read.core_mut().chain(
        "",
        &[polyspec_orm::core::ChainKey { column: "name", ..polyspec_orm::core::ChainKey::EMPTY }],
        vec![polyspec_orm::core::Arg::Value(polyspec_orm::args::Value::One(text("red")))],
    );
    assert_eq!(code(polyspec_orm::model::get(&read).await), polyspec_orm::codes::NO_ROWS, "{driver}: default read of a soft-deleted row");
    let without = polyspec_orm::model::restore(&with::<Membership>(&db, &[("team_id", i(1)), ("member_id", i(2))])).await;
    assert_eq!(code(without), polyspec_orm::codes::CONFIG, "{driver}: restore of an audited row without an audit");

    // A set value outside the key is a new value written to the restored row.
    let restored = adb
        .transaction(async || polyspec_orm::model::restore(&with::<Membership>(&db, &[("team_id", i(1)), ("member_id", i(2)), ("note", text("n2"))])).await)
        .audit([("actor", "restore")])
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: restore: {e}"));
    // The audit record's key can skip numbers that a failed transaction used, differently on each database, so it is found by actor.
    let audit_seq = async |actor: &str| -> String {
        let rows = text_rows(&db, &format!("SELECT {} FROM audit WHERE actor = '{actor}'", cast_text(driver, "seq"))).await;
        assert_eq!(rows.len(), 1, "{driver}: audit records of {actor}: {rows:?}");
        rows[0][0].clone()
    };
    let restore_seq: i64 = audit_seq("restore").await.parse().expect("audit seq");
    let want: BTreeMap<String, Val> = [
        ("seq", Val::I64(seq)),
        ("team_id", Val::I64(1)),
        ("member_id", Val::I64(2)),
        ("note", Val::Str("n2".into())),
        ("audit_seq", Val::I64(restore_seq)),
        ("deleted_at", Val::Null),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    assert_eq!(shown(&restored.values), shown(&want), "{driver}: restored membership");
    let again = adb
        .transaction(async || polyspec_orm::model::restore(&with::<Membership>(&db, &[("seq", i(seq)), ("note", text("n3"))])).await)
        .audit([("actor", "again")])
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: restore again: {e}"));
    assert_eq!(shown(&again.values), shown(&restored.values), "{driver}: restore of a row that is not deleted returns the unchanged row");

    let label = polyspec_orm::model::restore(&with::<Label>(&db, &[("name", text("red")), ("color", text("y"))]))
        .await
        .unwrap_or_else(|e| panic!("{driver}: restore label: {e}"));
    let want: BTreeMap<String, Val> = [("id", Val::I64(id)), ("name", Val::Str("red".into())), ("color", Val::Str("y".into())), ("deleted_at", Val::Null)]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect();
    assert_eq!(shown(&label.values), shown(&want), "{driver}: restored label");
    assert_eq!(
        code(polyspec_orm::model::restore(&with::<Label>(&db, &[("name", text("blue"))])).await),
        polyspec_orm::codes::NO_ROWS,
        "{driver}: restore of an absent row"
    );
    assert_eq!(
        code(polyspec_orm::model::restore(&with::<Label>(&db, &[("color", text("x"))])).await),
        polyspec_orm::codes::IR_INVALID,
        "{driver}: restore without the values of a key"
    );
    assert_eq!(code(polyspec_orm::model::restore(&with::<Label>(&db, &[])).await), polyspec_orm::codes::IR_INVALID, "{driver}: restore without key values");

    let change = if driver == "mysql" { "`change`" } else { "\"change\"" };
    let cast = |column: &str| cast_text(driver, column);
    let history = text_rows(
        &db,
        &format!(
            "SELECT {change}, {}, {}, {}, {}, {}, CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END FROM membership_history ORDER BY history_id",
            cast("previous_audit_seq"),
            cast("seq"),
            cast("team_id"),
            cast("member_id"),
            cast("audit_seq")
        ),
    )
    .await;
    let s = seq.to_string();
    let (created, deleted, restored) = (audit_seq("create").await, audit_seq("delete").await, audit_seq("restore").await);
    let want = [
        ["insert", "NULL", &s, "1", "2", &created, "live"],
        ["update", &created, &s, "1", "2", &deleted, "deleted"],
        ["update", &deleted, &s, "1", "2", &restored, "live"],
    ];
    assert_eq!(history, want.map(|r| r.map(str::to_owned).to_vec()), "{driver}: membership_history");
    let live = text_rows(&db, &format!("SELECT {} FROM label WHERE deleted_at IS NULL", cast("COUNT(*)"))).await;
    assert_eq!(live, [["1".to_owned()]], "{driver}: live labels");
    let failed = text_rows(&db, &format!("SELECT {} FROM audit WHERE actor = 'duplicate'", cast("COUNT(*)"))).await;
    assert_eq!(failed, [["0".to_owned()]], "{driver}: audit records of the failed transaction");
    db.close().await;
}
