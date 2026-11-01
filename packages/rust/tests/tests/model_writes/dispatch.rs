//! The generated-model ops of the model_writes recipe (docs/spec/feature-coverage.md FCV-4): each op calls the generated model
//! that its step names, on the connection that model.connect opened. The three trial binaries include the models of the
//! bench set as `crate::model` and share this file. A model, a column or an op without an arm here fails its step by name.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use polyspec_orm::{Config, Db};
use polyspec_orm_tests::recipe::{ModelDispatcher, ModelFuture};
use serde_json::{json, Value};

use crate::model::{connect, Author, CompositeAccount};

/// The dispatcher of one case: the connections that model.connect opened, by name.
#[derive(Default)]
pub struct Models {
    connections: HashMap<String, Db>,
}

/// The factory that the recipe helper calls once for each case.
pub fn models() -> Box<dyn ModelDispatcher> {
    Box::new(Models::default())
}

/// The keys that the generated models of the bench set read their encrypted columns with (the native model tests use them).
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

/// The op of `step` on `db`: its fields, which the expect of the step compares.
async fn run(db: &Db, op: &str, step: &Value) -> Result<Value, String> {
    match op {
        "model.create" => set_account(db, &step["values"])?.create().await.map(|_| json!({})).map_err(fail),
        "model.creates" => {
            let rows = step["rows"].as_array().into_iter().flatten().map(|row| set_account(db, row)).collect::<Result<Vec<_>, _>>()?;
            let count = account(db).creates(rows, batch(step)?).await.map_err(fail)?;
            Ok(json!({ "value": { "int": count.to_string() } }))
        }
        "model.save" => set_account(db, &step["values"])?.save().await.map(|_| json!({})).map_err(fail),
        "model.duplicate_create" => {
            let mut row = set_account(db, &step["values"])?.duplication(set_account(db, &step["duplication"])?);
            row.create().await.map(|_| json!({})).map_err(fail)
        }
        "model.update" => {
            let Some(mut row) = find_account(db, &step["key"]).await? else {
                return Err("model.update: the key names no row".to_owned());
            };
            for (column, value) in columns(&step["set"])? {
                if column != "name" {
                    return Err(format!("CompositeAccount column {column} has no recipe update"));
                }
                row = row.set_name(text(value)?);
            }
            row.update(false).await.map(|()| json!({})).map_err(fail)
        }
        "model.delete" => {
            let rows = filter_account(db, &step["where"])?.gets().await.map_err(fail)?;
            rows.delete(false).await.map(|()| json!({})).map_err(fail)
        }
        "model.count" => {
            let count = filter_account(db, &step["where"])?.get_count().await.map_err(fail)?;
            Ok(json!({ "value": { "int": count.to_string() } }))
        }
        "model.get_by" => {
            let wanted = names(&step["columns"]);
            let rows = if step["model"] == "Author" {
                match Author::new().connect(db).get_by_seq(int(&step["key"]["seq"])?).await.map_err(fail)? {
                    None => Vec::new(),
                    Some(row) => vec![cells(&wanted, |column| author_cell(&row, column))?],
                }
            } else {
                match find_account(db, &step["key"]).await? {
                    None => Vec::new(),
                    Some(row) => vec![cells(&wanted, |column| composite_cell(&row, column))?],
                }
            };
            Ok(json!({ "rows": rows }))
        }
        "model.query" => {
            let mut query = filter_account(db, &step["where"])?;
            for column in step["order"].as_array().into_iter().flatten() {
                query = match column.as_str() {
                    Some("account_id") => query.order_by_account_id_asc(),
                    other => return Err(format!("CompositeAccount column {other:?} has no recipe order")),
                };
            }
            let collection = query.gets().await.map_err(fail)?;
            let wanted = names(&step["columns"]);
            let rows = collection.iter().map(|(_, row)| cells(&wanted, |column| composite_cell(row, column))).collect::<Result<Vec<_>, _>>()?;
            Ok(json!({ "rows": rows }))
        }
        "model.arithmetic" => {
            let column = step["column"].as_str().unwrap_or_default();
            if column != "read_count" {
                return Err(format!("Author column {column} has no recipe arithmetic"));
            }
            let Some(mut row) = Author::new().connect(db).get_by_seq(int(&step["key"]["seq"])?).await.map_err(fail)? else {
                return Err("model.arithmetic: the key names no row".to_owned());
            };
            let amount = i32::try_from(int(&step["amount"])?).map_err(|e| e.to_string())?;
            row = match step["operation"].as_str() {
                Some("plus") => row.plus_read_count(amount),
                Some("minus") => row.minus_read_count(amount),
                other => return Err(format!("the operation {other:?} is neither plus nor minus")),
            };
            row.update(false).await.map(|()| json!({})).map_err(fail)
        }
        other => Err(format!("OP_UNKNOWN {other}")),
    }
}

fn fail(error: polyspec_orm::Error) -> String {
    error.to_string()
}

fn account(db: &Db) -> CompositeAccount {
    CompositeAccount::new().connect(db)
}

/// A CompositeAccount with the columns of `values`, which are the setters of the recipe.
fn set_account(db: &Db, values: &Value) -> Result<CompositeAccount, String> {
    let mut row = account(db);
    for (column, value) in columns(values)? {
        row = match column.as_str() {
            "tenant_id" => row.set_tenant_id(int(value)?),
            "account_id" => row.set_account_id(int(value)?),
            "name" => row.set_name(text(value)?),
            other => return Err(format!("CompositeAccount column {other} has no recipe setter")),
        };
    }
    Ok(row)
}

/// The CompositeAccount filter of the equalities of `where`: tenant_id first, then account_id as the AND of the builder
/// (the generated name of the account_id filter is and_account_id, since the model has a field of that name).
fn filter_account(db: &Db, where_: &Value) -> Result<CompositeAccount, String> {
    let map = columns(where_)?;
    if let Some(column) = map.keys().find(|column| *column != "tenant_id" && *column != "account_id") {
        return Err(format!("CompositeAccount column {column} has no recipe filter"));
    }
    let mut query = account(db);
    if let Some(value) = map.get("tenant_id") {
        query = query.tenant_id(int(value)?);
    }
    if let Some(value) = map.get("account_id") {
        query = query.and_account_id(int(value)?);
    }
    Ok(query)
}

/// The CompositeAccount row of a key with `tenant_id` and `account_id`, or None when no row has it.
async fn find_account(db: &Db, key: &Value) -> Result<Option<CompositeAccount>, String> {
    account(db).get_by_tenant_id_and_account_id(int(&key["tenant_id"])?, int(&key["account_id"])?).await.map_err(fail)
}

fn author_cell(row: &Author, column: &str) -> Result<Value, String> {
    match column {
        "read_count" => Ok(json!({ "int": row.get_read_count().map_err(fail)?.to_string() })),
        other => Err(format!("Author column {other} has no recipe getter")),
    }
}

fn composite_cell(row: &CompositeAccount, column: &str) -> Result<Value, String> {
    match column {
        "name" => Ok(json!({ "text": row.get_name().map_err(fail)? })),
        other => Err(format!("CompositeAccount column {other} has no recipe getter")),
    }
}

/// One row of the cells of `columns`, each read by `cell`.
fn cells(columns: &[String], cell: impl Fn(&str) -> Result<Value, String>) -> Result<Value, String> {
    columns.iter().map(|column| cell(column)).collect::<Result<Vec<_>, _>>().map(Value::Array)
}

fn names(array: &Value) -> Vec<String> {
    array.as_array().into_iter().flatten().filter_map(|name| name.as_str().map(str::to_owned)).collect()
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

fn batch(step: &Value) -> Result<usize, String> {
    let count = step["batch"].as_u64().ok_or_else(|| "batch is not a count".to_owned())?;
    usize::try_from(count).map_err(|e| e.to_string())
}
