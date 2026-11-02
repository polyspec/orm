//! The query.search op of the fulltext_search recipe (docs/spec/feature-coverage.md FCV-4, PRT-75): the count of the Author
//! model under a fulltext_boolean condition over the columns of the step. The statement is compiled by the planner of the
//! case dialect (which refuses SQLite, DIA-187). A text with no term is run on the case connection through the generated
//! model, so that the bind check refuses it with IR_INVALID. The three trial binaries include the models of the bench set as
//! `crate::model` and share this file.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use polyspec_orm::args::Value as Slot;
use polyspec_orm::core::{Arg, ChainKey};
use polyspec_orm::{Config, Db, Dialect, Model, Param};
use polyspec_orm_tests::recipe::{ModelDispatcher, ModelFuture};
use serde_json::{json, Value};

use crate::model::{connect, Author};

/// The dispatcher of one case: the connections that model.connect opened, by name, and the dialect of the case database.
pub struct Models {
    connections: HashMap<String, Db>,
    dialect: Dialect,
}

/// The factory that the recipe helper calls once for each case.
pub fn models(dialect: Dialect) -> Box<dyn ModelDispatcher> {
    Box::new(Models { connections: HashMap::new(), dialect })
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
            match op {
                "query.search" => search(db, self.dialect, step).await,
                other => Err(format!("OP_UNKNOWN {other}")),
            }
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

fn fail(error: polyspec_orm::Error) -> String {
    error.to_string()
}

/// The fields of query.search: the statement of the count and the bind value after the DIA-6 transform.
async fn search(db: &Db, dialect: Dialect, step: &Value) -> Result<Value, String> {
    if step["model"] != "Author" {
        return Err(format!("model {} has no query.search entry", step["model"]));
    }
    let text = step["text"].as_str().ok_or_else(|| "query.search: text is not a string".to_owned())?;
    let names = step["columns"].as_array().map(|columns| columns.iter().filter_map(Value::as_str).collect::<Vec<_>>());
    let columns: &'static [&'static str] = match names.as_deref() {
        Some(["name", "description"]) => &["name", "description"],
        other => return Err(format!("query.search columns {other:?} have no recipe entry")),
    };
    let mut core = Author::new().connect(db).into_core();
    let key = ChainKey { conn: "", op: "fulltext_boolean", column: "", columns, compare: "" };
    core.chain("", &[key], vec![Arg::Value(Slot::One(Param::Str(text.to_owned())))]);
    let plan = polyspec_orm::testing::compile_core_request(&core, "count", dialect).map_err(fail)?;
    let [statement] = plan.steps.as_slice() else {
        return Err(format!("query.search compiled {} statements, want 1", plan.steps.len()));
    };
    // The value is the one the statement binds: the transform that the plan declares for its slot (DIA-6 declares
    // fulltext_boolean on MySQL only; PostgreSQL binds the text as it is).
    let boolean = statement.bind_slots.first().is_some_and(|slot| slot.transform == "fulltext_boolean");
    let value = if boolean { polyspec_orm::value::fulltext_boolean(text) } else { text.to_owned() };
    if boolean && value.is_empty() {
        polyspec_orm::model::get_count(&core).await.map_err(fail)?;
        return Err("query.search ran a blank text without a bind-check error".to_owned());
    }
    Ok(json!({ "sql": statement.sql, "params": [{ "text": value }] }))
}
