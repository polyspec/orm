//! contracts/fixtures/restore.dbs의 membership과 label을 column 이름으로 읽고 쓰는 model과, soft delete한
//! 행을 restore로 되돌리는 case(clients/go/orm/restore_test.go의 restoreCase와 같은 순서). restore.rs와
//! coverage_audit_triggers.rs가 함께 쓴다.

use std::collections::BTreeMap;

use orm::db::Pool;
use orm::{Core, Db, Entity, Model, Param, Schema, Val};
use sqlx::Row;

pub static SCHEMA: Schema =
    Schema::new(include_str!("../../../../../contracts/fixtures/restore.dbs"), "sha256:3a0609ba5a120872d86acb52e37ce62848430e6c579e99c091f8ec024d773ddd");

/// restore fixture가 만드는 table.
#[allow(dead_code)]
pub const TABLES: [&str; 3] = ["label", "membership", "membership_history"];

/// column 이름으로 값을 읽고 쓰는 model.
macro_rules! row_model {
    ($name:ident, $entity:ident, $entity_name:literal, $columns:expr) => {
        static $entity: Entity =
            Entity { name: $entity_name, schema: &SCHEMA, new: orm::model::new_boxed::<$name>, collect: orm::model::collect_boxed::<$name> };

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

row_model!(Membership, MEMBERSHIP, "membership", ["seq", "team_id", "member_id", "note", "operation_id", "deleted_at"]);
row_model!(Label, LABEL, "label", ["id", "name", "color", "deleted_at"]);

/// 연결하고 값을 정한 model.
fn with<M: Model>(db: &Db, values: &[(&str, Param)]) -> M {
    let mut core = Core::new(M::entity());
    core.connect(db);
    for (column, value) in values {
        core.set(column, value.clone());
    }
    M::from_core(core)
}

fn code<T>(r: orm::Result<T>) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => e.code().to_owned(),
    }
}

/// model 값의 이름 순서 표기. MySQL driver가 text를 byte로 돌려주므로 UTF-8 byte는 문자열로 적는다.
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

/// query의 row를 읽는다. 각 값은 문자열이나 NULL이며 NULL은 "NULL"이다.
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
    }
}

/// dsn의 database에 restore.dbs를 설치하고 soft delete한 행을 restore로 되돌린다. membership은 unique key
/// (team_id, member_id)와 exclude (note)를 가진 audit table이고 label은 unique key (name)를 가진 audit 없는
/// table이다. 확인하는 것:
///   - soft delete한 행의 unique key 값은 남으므로 같은 key의 insert는 DUPLICATE_KEY다.
///   - 기본 read는 지운 행을 읽지 않는다.
///   - restore는 primary key나 unique key 하나의 set 값으로 지운 행을 찾아 soft delete column을 NULL로 쓰는
///     update를 하고, 되돌린 행을 돌려준다. audit table이면 transaction의 operation id를 쓰고 trigger가 그
///     update를 기록하며, operation id가 없으면 CONFIG다.
///   - 지워지지 않은 행의 restore는 아무것도 쓰지 않고 그 행을 돌려주며, 없는 행의 restore는 NO_ROWS다.
///   - key 밖의 set 값은 되돌리는 행에 함께 쓰는 새 값이며, 지워지지 않은 행에는 쓰지 않는다.
///   - key의 값이 없는 restore와 set 값이 없는 restore는 CONFIG다.
pub async fn restore_case(driver: &str, dsn: &str) {
    let db = Db::connect(dsn, 2, orm::Config::default()).await.unwrap_or_else(|e| panic!("{driver}: connect: {e}"));
    db.utils().schema().install(&SCHEMA).await.unwrap_or_else(|e| panic!("{driver}: install: {e}"));
    let i = Param::I64;
    let text = |s: &str| Param::Str(s.to_owned());
    let (seq, id) = db
        .transaction(async || {
            let m = orm::model::create(&mut with::<Membership>(&db, &[("team_id", i(1)), ("member_id", i(2)), ("note", text("n1"))])).await?;
            let seq = m.value("seq").expect("generated seq").as_i64()?;
            let l = orm::model::create(&mut with::<Label>(&db, &[("name", text("red")), ("color", text("x"))])).await?;
            Ok((seq, l.value("id").expect("generated id").as_i64()?))
        })
        .operation(1)
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: create: {e}"));
    db.transaction(async || {
        orm::model::delete(&with::<Membership>(&db, &[("seq", i(seq))]), false).await?;
        orm::model::delete(&with::<Label>(&db, &[("id", i(id))]), false).await
    })
    .operation(2)
    .retry(0)
    .await
    .unwrap_or_else(|e| panic!("{driver}: delete: {e}"));

    let duplicate = db
        .transaction(async || orm::model::create(&mut with::<Membership>(&db, &[("team_id", i(1)), ("member_id", i(2))])).await.map(|_| ()))
        .operation(3)
        .retry(0)
        .await;
    assert_eq!(code(duplicate), orm::codes::DUPLICATE_KEY, "{driver}: insert of the key of a soft-deleted row");
    let mut read: Label = with(&db, &[]);
    read.core_mut().chain(
        "",
        &[orm::core::ChainKey { column: "name", ..orm::core::ChainKey::EMPTY }],
        vec![orm::core::Arg::Value(orm::args::Value::One(text("red")))],
    );
    assert_eq!(code(orm::model::get(&read).await), orm::codes::NO_ROWS, "{driver}: default read of a soft-deleted row");
    let without = orm::model::restore(&with::<Membership>(&db, &[("team_id", i(1)), ("member_id", i(2))])).await;
    assert_eq!(code(without), orm::codes::CONFIG, "{driver}: restore of an audited row without an operation id");

    // key 밖의 set 값은 되돌리는 행에 함께 쓰는 새 값이다.
    let restored = db
        .transaction(async || orm::model::restore(&with::<Membership>(&db, &[("team_id", i(1)), ("member_id", i(2)), ("note", text("n2"))])).await)
        .operation(4)
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: restore: {e}"));
    let want: BTreeMap<String, Val> = [
        ("seq", Val::I64(seq)),
        ("team_id", Val::I64(1)),
        ("member_id", Val::I64(2)),
        ("note", Val::Str("n2".into())),
        ("operation_id", Val::I64(4)),
        ("deleted_at", Val::Null),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    assert_eq!(shown(&restored.values), shown(&want), "{driver}: restored membership");
    let again = db
        .transaction(async || orm::model::restore(&with::<Membership>(&db, &[("seq", i(seq)), ("note", text("n3"))])).await)
        .operation(5)
        .retry(0)
        .await
        .unwrap_or_else(|e| panic!("{driver}: restore again: {e}"));
    assert_eq!(shown(&again.values), shown(&restored.values), "{driver}: restore of a row that is not deleted returns the unchanged row");

    let label = orm::model::restore(&with::<Label>(&db, &[("name", text("red")), ("color", text("y"))]))
        .await
        .unwrap_or_else(|e| panic!("{driver}: restore label: {e}"));
    let want: BTreeMap<String, Val> = [("id", Val::I64(id)), ("name", Val::Str("red".into())), ("color", Val::Str("y".into())), ("deleted_at", Val::Null)]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect();
    assert_eq!(shown(&label.values), shown(&want), "{driver}: restored label");
    assert_eq!(code(orm::model::restore(&with::<Label>(&db, &[("name", text("blue"))])).await), orm::codes::NO_ROWS, "{driver}: restore of an absent row");
    assert_eq!(
        code(orm::model::restore(&with::<Label>(&db, &[("color", text("x"))])).await),
        orm::codes::CONFIG,
        "{driver}: restore without the values of a key"
    );
    assert_eq!(code(orm::model::restore(&with::<Label>(&db, &[])).await), orm::codes::CONFIG, "{driver}: restore without key values");

    let change = if driver == "mysql" { "`change`" } else { "\"change\"" };
    let cast = |column: &str| if driver == "mysql" { format!("CAST({column} AS CHAR)") } else { format!("CAST({column} AS TEXT)") };
    let history = text_rows(
        &db,
        &format!(
            "SELECT {change}, {}, {}, {}, {}, {}, CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END FROM membership_history ORDER BY history_id",
            cast("previous_operation_id"),
            cast("seq"),
            cast("team_id"),
            cast("member_id"),
            cast("operation_id")
        ),
    )
    .await;
    let s = seq.to_string();
    let want = [["insert", "NULL", &s, "1", "2", "1", "live"], ["update", "1", &s, "1", "2", "2", "deleted"], ["update", "2", &s, "1", "2", "4", "live"]];
    assert_eq!(history, want.map(|r| r.map(str::to_owned).to_vec()), "{driver}: membership_history");
    let live = text_rows(&db, &format!("SELECT {} FROM label WHERE deleted_at IS NULL", cast("COUNT(*)"))).await;
    assert_eq!(live, [["1".to_owned()]], "{driver}: live labels");
    db.close().await;
}
