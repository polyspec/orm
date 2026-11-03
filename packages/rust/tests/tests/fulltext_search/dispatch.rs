//! The query.search op of the fulltext_search recipe (docs/spec/feature-coverage.md FCV-4, PRT-75): the count of the Author
//! model under a fulltext_boolean condition over the columns of the step. The statement is compiled by the planner of the
//! case dialect (which refuses SQLite, DIA-187). A text with no term is run on the case connection through the generated
//! model, so that the bind check refuses it with IR_INVALID. The three trial binaries include the models of the bench set as
//! `crate::model` and share this file.

use polyspec_orm::args::Value as Slot;
use polyspec_orm::core::{Arg, ChainKey};
use polyspec_orm::{Db, Dialect, Model, Param};
use polyspec_orm_tests::bench_models::{bench_dispatcher, fail, BenchModels};
use polyspec_orm_tests::recipe::ModelDispatcher;
use serde_json::{json, Value};

use crate::model::{Author, SCHEMA};

#[path = "chain.rs"]
mod chain;

/// The factory that the recipe helper calls once for each case.
pub fn models(dialect: Dialect) -> Box<dyn ModelDispatcher> {
    bench_dispatcher(&SCHEMA, FulltextSearch { dialect })
}

/// The query.search op of the fulltext_search recipe, on the dialect of the case database.
pub struct FulltextSearch {
    dialect: Dialect,
}

impl BenchModels for FulltextSearch {
    async fn run(&self, db: &Db, op: &str, step: &Value) -> Result<Value, String> {
        match op {
            "query.search" => search(db, self.dialect, step).await,
            "query.search_chain" => chain::search_chain(db, step).await,
            other => Err(format!("OP_UNKNOWN {other}")),
        }
    }
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
