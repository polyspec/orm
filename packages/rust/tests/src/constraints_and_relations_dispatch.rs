//! The generated-model ops of the constraints_and_relations recipe (docs/spec/feature-coverage.md FCV-4): each op calls the
//! generated model that its step names (Author, User or NoteReader) on the connection that model.connect opened. The three
//! trial binaries include the models of the bench set as `crate::model` and share this file. A model, a column or an op
//! without an arm here fails its step by name.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use polyspec_orm::{Config, Db};
use polyspec_orm_tests::recipe::{ModelDispatcher, ModelFuture};
use serde_json::{json, Value};

use crate::model::{connect, Author, NoteReader, SharedNote, User};

/// The dispatcher of one case: the connections that model.connect opened, by name.
#[derive(Default)]
pub struct Models {
    connections: HashMap<String, Db>,
}

/// The factory that the recipe helper calls once for each case.
pub fn models() -> Box<dyn ModelDispatcher> {
    Box::new(Models::default())
}

/// The keys that the generated models of the bench set read their encrypted columns with.
fn bench_config() -> Config {
    Config { aes_key: "bench-salt".into(), blind_index_key: "bench-blind-index".into(), ..Default::default() }
}

impl ModelDispatcher for Models {
    fn connect<'a>(&'a mut self, name: &'a str, dsn: &'a str, pool_size: u32) -> ModelFuture<'a> {
        Box::pin(async move {
            let db = connect(dsn, pool_size, bench_config()).await.map_err(fail)?;
            self.connections.insert(name.to_owned(), db);
            Ok(json!({}))
        })
    }

    fn call<'a>(&'a mut self, op: &'a str, connection: &'a str, step: &'a Value) -> ModelFuture<'a> {
        Box::pin(async move {
            let Some(db) = self.connections.get(connection) else {
                return Err(format!("model op: connection {connection} is not bound by model.connect"));
            };
            run(db, op, step).await
        })
    }

    fn close<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            for (_, db) in self.connections.drain() {
                db.close().await;
            }
        })
    }
}

/// The op of `step` on `db`, routed by the model that the step names; its fields are what the expect of the step compares.
async fn run(db: &Db, op: &str, step: &Value) -> Result<Value, String> {
    match step["model"].as_str() {
        Some("Author") => author_op(db, op, step).await,
        Some("User") => user_op(db, op, step).await,
        Some("NoteReader") => note_reader_op(db, op, step).await,
        other => Err(format!("model {other:?} has no recipe entry")),
    }
}

async fn author_op(db: &Db, op: &str, step: &Value) -> Result<Value, String> {
    match op {
        "model.count" => {
            let count = filter_author(db, &step["where"])?.get_count().await.map_err(fail)?;
            Ok(json!({ "value": { "int": count.to_string() } }))
        }
        "model.get_by" => {
            let wanted = names(&step["columns"]);
            let rows = match Author::new().connect(db).get_by_seq(int(&step["key"]["seq"])?).await.map_err(fail)? {
                None => Vec::new(),
                Some(row) => vec![cells(&wanted, |column| author_cell(&row, column))?],
            };
            Ok(json!({ "rows": rows }))
        }
        "model.query" => {
            let mut query = filter_author(db, &step["where"])?;
            for column in step["order"].as_array().into_iter().flatten() {
                query = match column.as_str() {
                    Some("seq") => query.order_by_seq_asc(),
                    other => return Err(format!("Author column {other:?} has no recipe order")),
                };
            }
            let limit = step["limit"].as_u64().unwrap_or(0);
            let offset = step["offset"].as_u64().unwrap_or(0);
            let collection = if limit > 0 {
                let offset = u32::try_from(offset).map_err(|e| e.to_string())?;
                let limit = u32::try_from(limit).map_err(|e| e.to_string())?;
                query.limit(offset, limit).gets().await.map_err(fail)?
            } else {
                query.gets().await.map_err(fail)?
            };
            let wanted = names(&step["columns"]);
            let rows = collection.iter().map(|(_, row)| cells(&wanted, |column| author_cell(row, column))).collect::<Result<Vec<_>, _>>()?;
            Ok(json!({ "rows": rows }))
        }
        "model.update" => {
            // The row is read with every column, as the update writes the changed columns of the row it read.
            let mut row = filter_author(db, &step["key"])?.add_all_columns().get().await.map_err(fail)?.ok_or("Author update: no row matches")?;
            for (column, value) in columns(&step["set"])? {
                row = match column.as_str() {
                    "like_count" => row.set_like_count(i32::try_from(int(value)?).map_err(|e| e.to_string())?),
                    "uuid" => row.set_uuid(text(value)?),
                    other => return Err(format!("Author column {other} has no recipe update")),
                };
            }
            row.update(false).await.map_err(fail)?;
            Ok(json!({}))
        }
        other => Err(format!("OP_UNKNOWN {other}")),
    }
}

async fn user_op(db: &Db, op: &str, step: &Value) -> Result<Value, String> {
    match op {
        "model.delete" => {
            let mut query = User::new().connect(db);
            for (column, value) in columns(&step["where"])? {
                query = match column.as_str() {
                    "seq" => query.seq(int(value)?),
                    other => return Err(format!("User column {other} has no recipe condition")),
                };
            }
            let rows = query.gets().await.map_err(fail)?;
            for row in rows.models() {
                row.delete(false).await.map_err(fail)?;
            }
            Ok(json!({}))
        }
        other => Err(format!("OP_UNKNOWN {other}")),
    }
}

/// model.query on NoteReader with its relation to the external SharedNote model: each row is the seq of the reader and the
/// title of its shared note, and a reader whose note is missing has no row.
async fn note_reader_op(db: &Db, op: &str, step: &Value) -> Result<Value, String> {
    match op {
        "model.query" => {
            let relation = &step["relation"];
            if relation["model"].as_str() != Some("SharedNote") || names_of_pairs(&relation["match"]) != [["shared_note_seq", "seq"]] {
                return Err(format!("NoteReader relation {relation} has no recipe entry"));
            }
            if names(&step["columns"]) != ["seq"] || names(&relation["columns"]) != ["title"] || names(&step["order"]) != ["seq"] {
                return Err(format!("NoteReader columns {} with relation {relation} have no recipe entry", step["columns"]));
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
        other => Err(format!("OP_UNKNOWN {other}")),
    }
}

fn fail(error: polyspec_orm::Error) -> String {
    error.to_string()
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
    for (column, value) in columns(where_)? {
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

fn author_cell(row: &Author, column: &str) -> Result<Value, String> {
    match column {
        "seq" => Ok(json!({ "int": row.get_seq().map_err(fail)?.to_string() })),
        "name" => Ok(json!({ "text": row.get_name().map_err(fail)? })),
        "read_count" => Ok(json!({ "int": row.get_read_count().map_err(fail)?.to_string() })),
        "like_count" => Ok(json!({ "int": row.get_like_count().map_err(fail)?.to_string() })),
        "uuid" => Ok(match row.get_uuid().map_err(fail)? {
            Some(uuid) => json!({ "text": uuid }),
            None => json!({ "null": "text" }),
        }),
        other => Err(format!("Author column {other} has no recipe getter")),
    }
}

/// One row of the cells of `columns`, each read by `cell`.
fn cells(columns: &[String], cell: impl Fn(&str) -> Result<Value, String>) -> Result<Value, String> {
    columns.iter().map(|column| cell(column)).collect::<Result<Vec<_>, _>>().map(Value::Array)
}

fn names(array: &Value) -> Vec<String> {
    array.as_array().into_iter().flatten().filter_map(|name| name.as_str().map(str::to_owned)).collect()
}

/// The column pairs of a relation match, each a list of two names.
fn names_of_pairs(array: &Value) -> Vec<Vec<String>> {
    array.as_array().into_iter().flatten().map(names).collect()
}

fn columns(object: &Value) -> Result<&serde_json::Map<String, Value>, String> {
    object.as_object().ok_or_else(|| format!("{object} is not an object of columns"))
}

fn int(wrapper: &Value) -> Result<i64, String> {
    let digits = wrapper["int"].as_str().ok_or_else(|| format!("{wrapper} is not an int wrapper"))?;
    digits.parse().map_err(|e: std::num::ParseIntError| format!("{wrapper}: {e}"))
}

fn text(wrapper: &Value) -> Result<String, String> {
    wrapper["text"].as_str().map(str::to_owned).ok_or_else(|| format!("{wrapper} is not a text wrapper"))
}
