//! The immutable write of the constraints_and_relations coverage; the constraint errors and the external relation are cases
//! of the recipe contracts/fixtures/constraints_and_relations/constraints_and_relations.json (FCV-3, FCV-4).
use super::coverage_env::{connect, run};
use polyspec_orm::{plan::Step, Core, Db, Entity, Model, Param, Schema};

use polyspec_orm_test_support::model_row;

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
