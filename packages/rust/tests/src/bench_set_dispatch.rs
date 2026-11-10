//! The generated-model ops of the model_queries and constraints_and_relations recipes (docs/spec/feature-coverage.md FCV-4):
//! each op calls the generated model that its step names (Author, User or NoteReader) on the connection that model.connect
//! opened. The test program includes the models of the bench set as `crate::model`, and the modules of both recipes share this file. A
//! model, a column or an op without an arm here fails its step by name.

use polyspec_orm::Db;
use polyspec_orm_tests::bench_models::{bench_dispatcher, cells, columns, fail, int, names, text, BenchModels};
use polyspec_orm_tests::recipe::ModelDispatcher;
use polyspec_orm_tests::recipe::ModelError;
use serde_json::{json, Value};

use crate::model::{Author, NoteReader, SharedNote, User, SCHEMA};

/// The factory that the recipe helper calls once for each case.
pub fn models() -> Box<dyn ModelDispatcher> {
    bench_dispatcher(&SCHEMA, BenchSet)
}

/// The ops of the model_queries and constraints_and_relations recipes.
pub struct BenchSet;

impl BenchModels for BenchSet {
    async fn run(&self, db: &Db, op: &str, step: &Value) -> Result<Value, ModelError> {
        run(db, op, step).await
    }
}

/// The op of `step` on `db`, routed by the model that the step names; its fields are what the expect of the step compares.
async fn run(db: &Db, op: &str, step: &Value) -> Result<Value, ModelError> {
    match polyspec_orm_tests::recipe_reads::read(step, "model")["model"].as_str() {
        Some("Author") => author_op(db, op, step).await,
        Some("User") => user_op(db, op, step).await,
        Some("NoteReader") => note_reader_op(db, op, step).await,
        other => Err(format!("model {other:?} has no recipe entry").into()),
    }
}

async fn author_op(db: &Db, op: &str, step: &Value) -> Result<Value, ModelError> {
    match op {
        "model.count" => {
            let count = filter_author(db, &polyspec_orm_tests::recipe_reads::read(step, "where")["where"])?.get_count().await.map_err(fail)?;
            Ok(json!({ "value": { "int": count.to_string() } }))
        }
        "model.get_by" => {
            let wanted = names(&polyspec_orm_tests::recipe_reads::read(step, "columns")["columns"]);
            let rows =
                match Author::new().connect(db).get_by_seq(int(&polyspec_orm_tests::recipe_reads::read(step, "key")["key"]["seq"])?).await.map_err(fail)? {
                    None => Vec::new(),
                    Some(row) => vec![cells(&wanted, |column| author_cell(&row, column))?],
                };
            Ok(json!({ "rows": rows }))
        }
        "model.query" => {
            let mut query = filter_author(db, &polyspec_orm_tests::recipe_reads::read(step, "where")["where"])?;
            for column in polyspec_orm_tests::recipe_reads::read(step, "order")["order"].as_array().into_iter().flatten() {
                query = match column.as_str() {
                    Some("seq") => query.order_by_seq_asc(),
                    other => return Err(format!("Author column {other:?} has no recipe order").into()),
                };
            }
            let limit = polyspec_orm_tests::recipe_reads::read(step, "limit")["limit"].as_u64().unwrap_or(0);
            let offset = polyspec_orm_tests::recipe_reads::read(step, "offset")["offset"].as_u64().unwrap_or(0);
            let collection = if limit > 0 {
                let offset = u32::try_from(offset).map_err(|e| e.to_string())?;
                let limit = u32::try_from(limit).map_err(|e| e.to_string())?;
                query.limit(offset, limit).gets().await.map_err(fail)?
            } else {
                query.gets().await.map_err(fail)?
            };
            let wanted = names(&polyspec_orm_tests::recipe_reads::read(step, "columns")["columns"]);
            let rows = collection.iter().map(|(_, row)| cells(&wanted, |column| author_cell(row, column))).collect::<Result<Vec<_>, _>>()?;
            Ok(json!({ "rows": rows }))
        }
        "model.update" => {
            // The row is read with every column, as the update writes the changed columns of the row it read.
            let mut row = filter_author(db, &polyspec_orm_tests::recipe_reads::read(step, "key")["key"])?
                .add_all_columns()
                .get()
                .await
                .map_err(fail)?
                .ok_or("Author update: no row matches")?;
            for (column, value) in columns(&polyspec_orm_tests::recipe_reads::read(step, "set")["set"])? {
                row = match column.as_str() {
                    "like_count" => row.set_like_count(i32::try_from(int(value)?).map_err(|e| e.to_string())?),
                    "uuid" => row.set_uuid(text(value)?),
                    other => return Err(format!("Author column {other} has no recipe update").into()),
                };
            }
            row.update(false).await.map_err(fail)?;
            Ok(json!({}))
        }
        other => Err(format!("OP_UNKNOWN {other}").into()),
    }
}

async fn user_op(db: &Db, op: &str, step: &Value) -> Result<Value, ModelError> {
    match op {
        "model.delete" => {
            let mut query = User::new().connect(db);
            for (column, value) in columns(&polyspec_orm_tests::recipe_reads::read(step, "where")["where"])? {
                query = match column.as_str() {
                    "seq" => query.seq(int(value)?),
                    other => return Err(format!("User column {other} has no recipe condition").into()),
                };
            }
            let rows = query.gets().await.map_err(fail)?;
            for row in rows.models() {
                row.delete(false).await.map_err(fail)?;
            }
            Ok(json!({}))
        }
        other => Err(format!("OP_UNKNOWN {other}").into()),
    }
}

/// model.query on NoteReader with its relation to the external SharedNote model: each row is the seq of the reader and the
/// title of its shared note, and a reader whose note is missing has no row.
async fn note_reader_op(db: &Db, op: &str, step: &Value) -> Result<Value, ModelError> {
    match op {
        "model.query" => {
            let relation = &polyspec_orm_tests::recipe_reads::read(step, "relation")["relation"];
            if relation["model"].as_str() != Some("SharedNote") || names_of_pairs(&relation["match"]) != [["shared_note_seq", "seq"]] {
                return Err(format!("NoteReader relation {relation} has no recipe entry").into());
            }
            if names(&polyspec_orm_tests::recipe_reads::read(step, "columns")["columns"]) != ["seq"]
                || names(&relation["columns"]) != ["title"]
                || names(&polyspec_orm_tests::recipe_reads::read(step, "order")["order"]) != ["seq"]
            {
                return Err(format!(
                    "NoteReader columns {} with relation {relation} have no recipe entry",
                    polyspec_orm_tests::recipe_reads::read(step, "columns")["columns"]
                )
                .into());
            }
            let rows =
                NoteReader::new().connect(db).relation(SharedNote::new().match_shared_note_seq_with_seq()).order_by_seq_asc().gets().await.map_err(fail)?;
            let mut out = Vec::new();
            for row in rows.models() {
                let Some(note) = row.get_shared_note_model().map_err(fail)? else { continue };
                out.push(json!([
                    { "int": row.get_seq().map_err(fail)?.to_string() },
                    { "text": note.get_title().map_err(fail)? }
                ]));
            }
            Ok(json!({ "rows": out }))
        }
        other => Err(format!("OP_UNKNOWN {other}").into()),
    }
}

/// The Author filter of the equalities of `where`, ANDed. The generated model has the plain filters user_seq, service_seq
/// and seq, and the and_ filters and_service_seq and and_seq, but no and_user_seq, so the conditions go in the order
/// user_seq, service_seq, seq (serde_json sorts the object keys): the first is the plain filter and each later one its
/// and_ filter. A user_seq after another condition has no generated filter and fails its step by name.
fn filter_author(db: &Db, where_: &Value) -> Result<Author, String> {
    let rank = |column: &str| match column {
        "user_seq" => Ok(0),
        "service_seq" => Ok(1),
        "seq" => Ok(2),
        other => Err(format!("Author column {other} has no recipe filter")),
    };
    let mut conditions = Vec::new();
    // A step with no where reads every row.
    let every_row = serde_json::Map::new();
    let equalities = if where_.is_null() { &every_row } else { columns(where_)? };
    for (column, value) in equalities {
        conditions.push((rank(column)?, column.as_str(), int(value)?));
    }
    conditions.sort_by_key(|(rank, _, _)| *rank);
    let mut query = Author::new().connect(db);
    for (position, (_, column, value)) in conditions.into_iter().enumerate() {
        query = match (column, position) {
            ("user_seq", 0) => query.user_seq(value),
            ("service_seq", 0) => query.service_seq(value),
            ("seq", 0) => query.seq(value),
            ("service_seq", _) => query.and_service_seq(value),
            ("seq", _) => query.and_seq(value),
            (other, _) => return Err(format!("Author column {other} has no recipe filter at position {position}")),
        };
    }
    Ok(query)
}

fn author_cell(row: &Author, column: &str) -> Result<Value, ModelError> {
    match column {
        "seq" => Ok(json!({ "int": row.get_seq().map_err(fail)?.to_string() })),
        "name" => Ok(json!({ "text": row.get_name().map_err(fail)? })),
        "read_count" => Ok(json!({ "int": row.get_read_count().map_err(fail)?.to_string() })),
        "like_count" => Ok(json!({ "int": row.get_like_count().map_err(fail)?.to_string() })),
        "uuid" => Ok(match row.get_uuid().map_err(fail)? {
            Some(uuid) => json!({ "text": uuid }),
            None => json!({ "null": "text" }),
        }),
        other => Err(format!("Author column {other} has no recipe getter").into()),
    }
}

/// The column pairs of a relation match, each a list of two names.
fn names_of_pairs(array: &Value) -> Vec<Vec<String>> {
    array.as_array().into_iter().flatten().map(names).collect()
}
