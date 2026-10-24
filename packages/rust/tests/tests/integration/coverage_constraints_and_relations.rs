//! constraints_and_relations: a database constraint violation becomes an error code of its kind,
//! and changes nothing.
use super::coverage_env::{code, connect, run};
use super::model::{Author, NoteReader, SharedNote, User};
use polyspec_orm::{Core, Db, Entity, Model, Param, Schema, plan::Step};

#[macro_use]
#[path = "../../../orm/tests/common/model_row.rs"]
mod model_row_support;

async fn execute_ddl(db: &Db, sql: String) {
    db.execute(&Step { sql, ..Step::default() }, &[]).await.unwrap();
}

async fn cleanup_refused_row(db: &Db, driver: &str) {
    execute_ddl(db, "DROP TABLE IF EXISTS refused_row".to_owned()).await;
    if driver == "postgres" {
        execute_ddl(db, "DROP FUNCTION IF EXISTS \"refused_row$immutable_update\"()".to_owned()).await;
        execute_ddl(db, "DROP FUNCTION IF EXISTS \"refused_row$immutable_delete\"()".to_owned()).await;
    }
}

async fn immutable_write_result(db: &Db) -> Result<(String, String, bool, i64), String> {
    db.utils().schema().install(&REFUSAL_SCHEMA).await.map_err(|error| error.to_string())?;
    let mut row = refused_row(db);
    row.core_mut().set("amount", Param::I64(1));
    let created = polyspec_orm::model::create(&mut row).await.map_err(|error| error.to_string())?;
    let seq = created.value("seq").ok_or("create returned no sequence")?.as_i64().map_err(|error| error.to_string())?;
    let mut changed = refused_row(db);
    changed.core_mut().set("seq", Param::I64(seq));
    changed.core_mut().set("amount", Param::I64(2));
    let (code, message, has_source) = match polyspec_orm::model::update(&mut changed, false).await {
        Ok(()) => ("ok".to_owned(), String::new(), false),
        Err(error) => (error.code().to_owned(), error.to_string(), std::error::Error::source(&error).is_some()),
    };
    let mut query = refused_row(db);
    query.core_mut().add_all_columns();
    let rows = polyspec_orm::model::gets(&query).await.map_err(|error| error.to_string())?.into_vec();
    let value = rows.first().and_then(|row| row.values.get("amount")).ok_or("refused row was not readable")?;
    let amount = value.as_i64().map_err(|error| error.to_string())?;
    Ok((code, message, has_source, amount))
}

static REFUSAL_SCHEMA: Schema =
    Schema::new(include_str!("../../../../../contracts/fixtures/refusal.dbs"), "sha256:b4173544710d221d7a8b1802fee458fcd58bd4eb70aba5c07fbfb126a94d017d");
static REFUSED_ROW: Entity = Entity {
    name: "refused_row",
    schema: &REFUSAL_SCHEMA,
    new: polyspec_orm::model::new_boxed::<CoverageRefusedRow>,
    collect: polyspec_orm::model::collect_boxed::<CoverageRefusedRow>,
};
const REFUSED_ROW_COLUMNS: [&str; 2] = ["seq", "amount"];
model_row!(CoverageRefusedRow, REFUSED_ROW, REFUSED_ROW_COLUMNS);

fn refused_row(db: &Db) -> CoverageRefusedRow {
    let mut core = Core::new(&REFUSED_ROW);
    core.connect(db);
    CoverageRefusedRow::from_core(core)
}

#[tokio::test]
// CFG-33: a violated foreign key, check or unique key is reported as FOREIGN_KEY, CONSTRAINT or DUPLICATE_KEY, and no row changes.
async fn coverage_constraint_errors() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("constraint_errors", async {
        let db = connect().await;
        let user = User::new().connect(&db).get_by_seq(1).await.unwrap().expect("a row");
        let author = Author::new().connect(&db).add_all_columns().get_by_seq(1).await.unwrap().expect("a row");
        let (user_before, author_before) = (user.to_array().unwrap(), author.to_array().unwrap());
        assert_eq!(code(user.delete(false).await), polyspec_orm::codes::FOREIGN_KEY, "delete a user that authors reference");
        let mut negative = author.clone().set_like_count(-1);
        assert_eq!(code(negative.update(false).await), polyspec_orm::codes::CONSTRAINT, "like_count violates ck_author_counts");
        let other = Author::new().connect(&db).get_by_seq(2).await.unwrap().expect("a row");
        let uuid = other.get_uuid().unwrap().expect("author 2 has a uuid").to_owned();
        let mut duplicate = author.set_uuid(uuid);
        assert_eq!(code(duplicate.update(false).await), polyspec_orm::codes::DUPLICATE_KEY, "uuid of author 2");
        assert_eq!(User::new().connect(&db).get_by_seq(1).await.unwrap().expect("a row").to_array().unwrap(), user_before, "user 1 changed");
        assert_eq!(
            Author::new().connect(&db).add_all_columns().get_by_seq(1).await.unwrap().expect("a row").to_array().unwrap(),
            author_before,
            "author 1 changed"
        );
        db.close().await;
    })
    .await;
}

#[tokio::test]
async fn coverage_external_relation() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("external_relation", async {
        let db = connect().await;
        let rows = NoteReader::new().connect(&db).relation(SharedNote::new().match_shared_note_seq_with_seq()).order_by_seq_asc().gets().await.unwrap();
        let mut got = Vec::new();
        for row in rows.models() {
            let note = row.get_shared_note_model().unwrap().expect("external shared_note relation");
            got.push(format!("{}:{}", row.get_seq().unwrap(), note.get_title().unwrap()));
        }
        assert_eq!(got, ["1:note-1", "2:note-1", "3:note-3"], "external relation values");
        db.close().await;
    })
    .await;
}

#[tokio::test]
// DBS-84: renderer-installed immutable write triggers reject updates without changing stored rows.
async fn coverage_immutable_write() {
    let _case = polyspec_orm_testcase::case!(polyspec_orm_testcase::DATABASE);
    run("immutable_write", async {
        let driver = std::env::var("ORM_FEATURE_DATABASE").expect("coverage database");
        let db = connect().await;
        cleanup_refused_row(&db, &driver).await;
        let result = immutable_write_result(&db).await;

        cleanup_refused_row(&db, &driver).await;
        db.close().await;

        let (code, message, has_source, after_value) = match result {
            Ok(value) => value,
            Err(error) => panic!("immutable case: {error}"),
        };
        assert_eq!(code, "DRIVER", "immutable update result: {message}");
        assert!(message.contains("table refused_row is immutable"), "immutable update message: {message}");
        assert!(has_source, "immutable update lost the driver cause: {message}");
        assert_eq!(after_value, 1, "the immutable row changed");
    })
    .await;
}
