//! How Rust reads a text column, on a SQLite file: SQL NULL arrives as `Val::Null` and empty text as `Val::Str("")`, two
//! values that stay apart, and the ordered_json stage of a json or jsons column refuses empty text. The test of COD-31
//! (docs/spec/codec.md).

use std::sync::LazyLock;

use polyspec_orm::{Core, Db, Entity, Model, Param, Val};

#[path = "common/sqlite_case.rs"]
mod sqlite_case;
use sqlite_case::{Database, SCHEMA};

async fn database(name: &str) -> Database {
    sqlite_case::database("val-text", name).await
}

#[macro_use]
#[path = "common/typed_model.rs"]
mod typed_model;

static ENTITY: LazyLock<Entity> = LazyLock::new(|| Entity {
    name: "bind_cell",
    schema: &SCHEMA,
    new: polyspec_orm::model::new_boxed::<BindCell>,
    collect: polyspec_orm::model::collect_boxed::<BindCell>,
});

// A row of bind_cell that keeps the value its body column arrived as.
typed_model!(BindCell, ENTITY, {
    seq: i64 = "seq",
    label: String = "label",
    body: Option<Val> = "body",
});

fn cell(db: &Db) -> BindCell {
    let mut core = Core::new(&ENTITY);
    core.connect(db);
    BindCell::from_core(core)
}

#[tokio::test]
async fn sql_null_and_empty_text_are_two_values() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let file = database("text").await;
    let db = Db::connect_schema(&file.dsn, &SCHEMA, 1, polyspec_orm::Config::default()).await.unwrap();
    for (label, body) in [("null", Param::Null), ("empty", Param::Str(String::new()))] {
        let mut row = cell(&db);
        row.core_mut().set("label", Param::Str(label.to_owned()));
        row.core_mut().set("body", body);
        polyspec_orm::model::create(&mut row).await.unwrap();
    }
    let mut read = cell(&db);
    read.core_mut().order_by("label", false, None);
    let rows = polyspec_orm::model::gets(&read).await.unwrap();
    let bodies: Vec<(String, String)> = rows
        .models()
        .map(|m| {
            let body = match &m.body {
                Some(Val::Null) => "Val::Null".to_owned(),
                Some(Val::Str(text)) => format!("Val::Str({text:?})"),
                other => format!("{other:?}"),
            };
            (m.label.clone(), body)
        })
        .collect();
    db.close().await;
    assert_eq!(bodies, vec![("empty".to_owned(), "Val::Str(\"\")".to_owned()), ("null".to_owned(), "Val::Null".to_owned())]);
    let decoded = polyspec_orm::codec::decode(&["ordered_json".to_owned()], &Val::Str(String::new()));
    assert_eq!(decoded.err().map(|e| e.code().to_owned()).as_deref(), Some(polyspec_orm::codes::CODEC_DECODE), "empty text with ordered_json");
}
