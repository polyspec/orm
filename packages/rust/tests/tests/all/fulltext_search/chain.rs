//! The query.search_chain op of the fulltext_search recipe (docs/spec/feature-coverage.md FCV-4): the statement of the
//! generated fulltext method of the mode. The generator scans this file for the generated methods it writes, so it holds
//! only the generated calls of the op.

use polyspec_orm::{Db, Model, Param};
use polyspec_orm_tests::bench_models::fail;
use polyspec_orm_tests::recipe::ModelError;
use serde_json::{json, Value};

use crate::model::Author;

/// The fields of query.search_chain (FCV-4): the statement of the generated fulltext method of the mode.
pub async fn search_chain(db: &Db, step: &Value) -> Result<Value, ModelError> {
    if polyspec_orm_tests::recipe_reads::read(step, "model")["model"] != "Author" {
        return Err(format!("model {} has no query.search_chain entry", polyspec_orm_tests::recipe_reads::read(step, "model")["model"]).into());
    }
    let text =
        polyspec_orm_tests::recipe_reads::read(step, "text")["text"].as_str().ok_or_else(|| "query.search_chain: text is not a string".to_owned())?.to_owned();
    let author = Author::new().connect(db);
    let chain = match polyspec_orm_tests::recipe_reads::read(step, "mode")["mode"].as_str() {
        Some("fulltext_boolean") => author.fulltext_boolean_name_with_description(text),
        Some("fulltext") => author.fulltext_name_with_description(text),
        other => return Err(format!("query.search_chain: mode {other:?} has no generated method").into()),
    };
    let statement = polyspec_orm::model::get_query(&chain.into_core()).await.map_err(fail)?;
    let params: Vec<Value> = statement
        .binds
        .iter()
        .map(|bind| match bind {
            Param::Str(text) => json!({ "text": text }),
            other => json!({ "text": format!("{other:?}") }),
        })
        .collect();
    Ok(json!({ "sql": statement.sql, "params": params }))
}
