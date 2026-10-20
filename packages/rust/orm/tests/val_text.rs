//! How Rust reads a text column, on a SQLite file: SQL NULL arrives as `Val::Null` and empty text as `Val::Str("")`, two
//! values that stay apart, and the ordered_json stage of a json or jsons column refuses empty text. The test of COD-31
//! (docs/spec/codec.md).

use std::sync::LazyLock;

use polyspec_orm::{Core, Db, Entity, Model, Param, Schema, Val};

/// The manifest text of contracts/fixtures/bench/bench.dbs alone: the document carries comments, which its manifest text
/// leaves out, so the document text itself is not the manifest text.
static MANIFEST_TEXT: LazyLock<String> = LazyLock::new(|| {
    let text = include_str!("../../../../contracts/fixtures/bench/bench.dbs");
    let document = polyspec_orm::dbspec::parse(text, &Default::default()).expect("bench.dbs parses").document;
    polyspec_orm::dbspec::manifest(&[&document]).expect("the manifest of bench.dbs").manifest_text
});

static SCHEMA: LazyLock<Schema> = LazyLock::new(|| Schema::new(&MANIFEST_TEXT, "sha256:349a7152d1ad701b2baf8e7e67e14660ec6a75cdd78d5ec61c430f9f6498a1ed"));

static ENTITY: LazyLock<Entity> = LazyLock::new(|| Entity {
    name: "bind_cell",
    schema: &SCHEMA,
    new: polyspec_orm::model::new_boxed::<BindCell>,
    collect: polyspec_orm::model::collect_boxed::<BindCell>,
});

/// A row of bind_cell that keeps the value its body column arrived as.
#[derive(Clone)]
struct BindCell {
    core: Core,
    seq: i64,
    label: String,
    body: Option<Val>,
}

impl Model for BindCell {
    fn entity() -> &'static Entity {
        &ENTITY
    }
    fn core(&self) -> &Core {
        &self.core
    }
    fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }
    fn from_core(core: Core) -> Self {
        BindCell { core, seq: 0, label: String::new(), body: None }
    }
    fn into_core(self) -> Core {
        self.core
    }
    fn assign(&mut self, name: &str, v: Val) -> polyspec_orm::Result<bool> {
        match name {
            "seq" => self.seq = v.as_i64()?,
            "label" => self.label = v.as_string()?,
            "body" => self.body = Some(v),
            _ => return Ok(false),
        }
        Ok(true)
    }
    fn value(&self, name: &str) -> Option<Val> {
        Some(match name {
            "seq" => Val::I64(self.seq),
            "label" => Val::Str(self.label.clone()),
            _ => return None,
        })
    }
}

fn cell(db: &Db) -> BindCell {
    let mut core = Core::new(&ENTITY);
    core.connect(db);
    BindCell::from_core(core)
}

/// A new SQLite file with the schema installed, in a directory of its own for one test. The directory is removed
/// when the value is dropped, also when the test fails an assertion and unwinds.
struct Database {
    dsn: String,
    dir: std::path::PathBuf,
}

impl Drop for Database {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.dir) {
            if !std::thread::panicking() {
                panic!("remove {}: {error}", self.dir.display());
            }
        }
    }
}

async fn database(name: &str) -> Database {
    let dir = std::env::temp_dir().join(format!("orm-rust-val-text-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let dsn = format!("sqlite://{}", dir.join(format!("{name}.sqlite")).display());
    let db = Db::connect(&dsn, 1, polyspec_orm::Config::default()).await.unwrap();
    db.utils().schema().install(&SCHEMA).await.unwrap();
    db.close().await;
    Database { dsn, dir }
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
