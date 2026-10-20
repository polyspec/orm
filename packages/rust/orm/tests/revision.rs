//! An update or delete with an expected revision (docs/spec/dsl.md "Writes", expectRevision) on a SQLite file of each
//! case: a match updates and bumps the revision or deletes, a mismatch fails with REVISION_CHANGED and changes
//! nothing.

use polyspec_orm::{Config, Core, Db, Entity, Model, Param, Schema, Val, codes};

static SCHEMA: Schema = Schema::new(
    "dbspec 1 revision\n\ntable note {\n  seq i64 identity\n  label varchar(32)\n  revision i64\n  primary key (seq)\n}\n",
    "sha256:7286b6df42d7283d34a9df49f2715210673a84e4c5f3243e5c47dd22f275641e",
);

static ENTITY: Entity =
    Entity { name: "note", schema: &SCHEMA, new: polyspec_orm::model::new_boxed::<Note>, collect: polyspec_orm::model::collect_boxed::<Note> };

#[derive(Clone)]
struct Note {
    core: Core,
    seq: i64,
    label: String,
    revision: i64,
}

impl Model for Note {
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
        Note { core, seq: 0, label: String::new(), revision: 0 }
    }
    fn into_core(self) -> Core {
        self.core
    }
    fn assign(&mut self, name: &str, v: Val) -> polyspec_orm::Result<bool> {
        match name {
            "seq" => self.seq = v.as_i64()?,
            "label" => self.label = v.as_string()?,
            "revision" => self.revision = v.as_i64()?,
            _ => return Ok(false),
        }
        Ok(true)
    }
    fn value(&self, name: &str) -> Option<Val> {
        Some(match name {
            "seq" => Val::I64(self.seq),
            "label" => Val::Str(self.label.clone()),
            "revision" => Val::I64(self.revision),
            _ => return None,
        })
    }
}

fn note(db: &Db) -> Note {
    let mut core = Core::new(&ENTITY);
    core.connect(db);
    Note::from_core(core)
}

/// A connection to a new SQLite file of the case that holds one note at revision 3, its path and the note's key.
async fn seeded(case: &str) -> (Db, std::path::PathBuf, i64) {
    let path = std::env::temp_dir().join(format!("orm-rust-revision-{case}-{}.sqlite", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let db = Db::connect(&format!("sqlite://{}", path.display()), 1, Config::default()).await.unwrap();
    db.utils().schema().install(&SCHEMA).await.unwrap();
    let mut first = note(&db);
    first.core_mut().set("label", Param::Str("first".into()));
    first.core_mut().set("revision", Param::I64(3));
    let created = polyspec_orm::model::create(&mut first).await.unwrap();
    (db, path, created.seq)
}

/// The (label, revision) of every stored note.
async fn stored(db: &Db) -> Vec<(String, i64)> {
    polyspec_orm::model::gets(&note(db)).await.unwrap().models().map(|n| (n.label.clone(), n.revision)).collect()
}

fn keyed(db: &Db, seq: i64, revision: i64) -> Note {
    let mut m = note(db);
    m.core_mut().set("seq", Param::I64(seq));
    m.core_mut().expect_revision("revision", revision);
    m
}

#[tokio::test]
// The test of DSL-108, DSL-114 (docs/spec).
async fn revision_update_match_bumps_the_revision() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let (db, path, seq) = seeded("update-match").await;
    let mut m = keyed(&db, seq, 3);
    m.core_mut().set("label", Param::Str("second".into()));
    polyspec_orm::model::update(&mut m, false).await.unwrap();
    assert_eq!(stored(&db).await, vec![("second".to_owned(), 4)]);
    db.close().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
// The test of DSL-108, DSL-114 (docs/spec).
async fn revision_update_mismatch_changes_nothing() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let (db, path, seq) = seeded("update-mismatch").await;
    let mut m = keyed(&db, seq, 2);
    m.core_mut().set("label", Param::Str("stale".into()));
    let err = polyspec_orm::model::update(&mut m, false).await.unwrap_err();
    assert_eq!(err.code(), codes::REVISION_CHANGED);
    assert_eq!(stored(&db).await, vec![("first".to_owned(), 3)]);
    db.close().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
// The test of DSL-108, DSL-114 (docs/spec).
async fn revision_delete_match_deletes() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let (db, path, seq) = seeded("delete-match").await;
    polyspec_orm::model::delete(&keyed(&db, seq, 3), false).await.unwrap();
    assert_eq!(stored(&db).await, vec![]);
    db.close().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
// The test of DSL-108, DSL-114 (docs/spec).
async fn revision_delete_mismatch_changes_nothing() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    let (db, path, seq) = seeded("delete-mismatch").await;
    let err = polyspec_orm::model::delete(&keyed(&db, seq, 4), false).await.unwrap_err();
    assert_eq!(err.code(), codes::REVISION_CHANGED);
    assert_eq!(stored(&db).await, vec![("first".to_owned(), 3)]);
    db.close().await;
    let _ = std::fs::remove_file(&path);
}
